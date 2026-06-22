/**
 * lib/exit-stepper.ts — The Shadow Exit stepper (Trading OS v3).
 *
 * Pure, synchronous bar-by-bar simulation of how a proposal's ExitPlan WOULD
 * have played out. No DB, no broker, no network. Same logic drives a live trade
 * and a phantom "would_have_*" shadow trade, so both score identically.
 *
 * Design rules (mirrors risk-gate.ts):
 *  - No mutation of inputs. stepPosition returns a NEW state every call.
 *  - Deterministic. First trigger wins, evaluated in a fixed per-bar order.
 *  - R math is borrowed from realisedRR — we never reinvent the sign convention.
 *
 * R measurement is always against the ORIGINAL plan stop (exit.stop_price), not
 * the live current_stop. That is the whole point of a breakeven trail: a winner
 * that runs to +1R, trails to breakeven, then comes back scores ~0R, not a fake
 * -1R. current_stop moves; the risk denominator does not.
 */

import { realisedRR } from './risk-gate';
import type { ProposalCard, ExitPlan, Direction, RegimeTier } from './proposal';
import type { Bar } from './feed';

export type PositionStatus =
  | 'open'
  | 'stopped'
  | 'target_hit'
  | 'time_stopped'
  | 'thesis_invalidated';

export interface PositionState {
  status: PositionStatus;
  entry_price: number;
  direction: Direction;
  current_stop: number; // moves when trail activates
  bars_held: number;
  max_favorable_excursion: number; // best price reached, for R tracking
  max_adverse_excursion: number; // worst price reached
  realised_r: number | null; // set when closed, null while open
  trail_active: boolean; // true once +1R hit and stop moved to breakeven
  exit_bar_time: number | null;
  exit_reason: PositionStatus | null;
}

/** The R threshold below which the trade is considered an eligible regime. */
const MIN_HEALTHY_TIER: RegimeTier = 4;

/**
 * Realised R against the ORIGINAL plan stop. Reuses realisedRR's sign
 * convention: a winning short (exit < entry) and a winning long (exit > entry)
 * both yield positive R. Rounded at the return boundary; null if geometry is
 * degenerate (zero risk distance).
 */
function realisedRAgainstPlan(
  entry: number,
  exitPrice: number,
  initialStop: number,
  direction: Direction,
): number | null {
  const r = realisedRR(entry, exitPrice, initialStop, direction);
  return Number.isFinite(r) ? Number(r.toFixed(4)) : null;
}

export function initPosition(card: ProposalCard): PositionState {
  return {
    status: 'open',
    entry_price: card.entry_price,
    direction: card.direction,
    current_stop: card.exit.stop_price,
    bars_held: 0,
    max_favorable_excursion: card.entry_price,
    max_adverse_excursion: card.entry_price,
    realised_r: null,
    trail_active: false,
    exit_bar_time: null,
    exit_reason: null,
  };
}

/**
 * Advance one bar. PURE — returns a NEW state, never mutates the input.
 *
 * Per-bar evaluation order (first trigger wins, deterministic):
 *   a. Already closed  -> return state unchanged.
 *   b. bars_held += 1
 *   c. Update MFE/MAE from the bar's high/low relative to direction.
 *   d. Thesis invalidation (manual flag OR regime tier dropped below 4) -> close @ close.
 *   e. Stop hit  -> close @ current_stop.
 *   f. Target hit -> close @ target.
 *   g. Trail activation at +trail_activate_r R -> move stop to breakeven (no close).
 *   h. Time stop -> close @ close.
 *
 * Conflict rule (within ONE bar): thesis > stop > target > time.
 *
 * Stop is checked before target on purpose. A single bar only gives us OHLC, not
 * the path within the bar — if the same bar's range spans both the stop and the
 * target, we cannot know which was touched first, so we assume the worst case
 * (the stop). This keeps shadow results pessimistic and never flatters the edge.
 */
export function stepPosition(
  state: PositionState,
  bar: Bar,
  exit: ExitPlan,
  opts?: { regime_tier?: RegimeTier; thesis_broken?: boolean },
): PositionState {
  // a. Closed positions are terminal — return the exact same reference.
  if (state.status !== 'open') return state;

  // b. New, independent state object. No input mutation.
  const next: PositionState = { ...state, bars_held: state.bars_held + 1 };

  // c. Track excursions in PRICE terms, relative to direction.
  if (next.direction === 'long') {
    next.max_favorable_excursion = Math.max(next.max_favorable_excursion, bar.h);
    next.max_adverse_excursion = Math.min(next.max_adverse_excursion, bar.l);
  } else {
    // short: favorable = lower price, adverse = higher price
    next.max_favorable_excursion = Math.min(next.max_favorable_excursion, bar.l);
    next.max_adverse_excursion = Math.max(next.max_adverse_excursion, bar.h);
  }

  const close = (reason: PositionStatus, exitPrice: number): PositionState => {
    next.status = reason;
    next.exit_reason = reason;
    next.exit_bar_time = bar.t;
    next.realised_r = realisedRAgainstPlan(
      next.entry_price,
      exitPrice,
      exit.stop_price, // ORIGINAL plan stop, never current_stop
      next.direction,
    );
    return next;
  };

  // d. Thesis invalidation — highest priority. Exit at the bar close.
  const tier = opts?.regime_tier;
  if (opts?.thesis_broken === true || (tier != null && tier < MIN_HEALTHY_TIER)) {
    return close('thesis_invalidated', bar.c);
  }

  // e. Stop hit — fills at the stop level (assume the stop order triggers there).
  const stopHit =
    next.direction === 'long' ? bar.l <= next.current_stop : bar.h >= next.current_stop;
  if (stopHit) {
    return close('stopped', next.current_stop);
  }

  // f. Target hit — fills at the target level.
  const targetHit =
    next.direction === 'long'
      ? bar.h >= exit.target_price
      : bar.l <= exit.target_price;
  if (targetHit) {
    return close('target_hit', exit.target_price);
  }

  // g. Trail activation: once price has reached +trail_activate_r R in our favor,
  //    move the stop to breakeven. Do NOT stop out on the same bar that activates
  //    it — the stop check above used the pre-move stop.
  const riskPerUnit = Math.abs(next.entry_price - exit.stop_price);
  if (!next.trail_active && riskPerUnit > 0) {
    const activationPrice =
      next.direction === 'long'
        ? next.entry_price + exit.trail_activate_r * riskPerUnit
        : next.entry_price - exit.trail_activate_r * riskPerUnit;
    const reached =
      next.direction === 'long'
        ? next.max_favorable_excursion >= activationPrice
        : next.max_favorable_excursion <= activationPrice;
    if (reached) {
      next.trail_active = true;
      next.current_stop = next.entry_price; // breakeven
    }
  }

  // h. Time stop — if we've held long enough with no other trigger, exit at close.
  if (next.bars_held >= exit.time_stop_days) {
    return close('time_stopped', bar.c);
  }

  return next;
}

/**
 * Initialise from a card, then fold stepPosition over the bar series. signals[i]
 * aligns to bars[i] (regime/thesis context known at that bar). Stops early the
 * moment the position closes — later bars are not evaluated.
 */
export function runToCompletion(
  card: ProposalCard,
  bars: Bar[],
  exit: ExitPlan,
  signals?: Array<{ regime_tier?: RegimeTier; thesis_broken?: boolean }>,
): PositionState {
  let state = initPosition(card);
  for (let i = 0; i < bars.length; i++) {
    if (state.status !== 'open') break;
    state = stepPosition(state, bars[i], exit, signals?.[i]);
  }
  return state;
}
