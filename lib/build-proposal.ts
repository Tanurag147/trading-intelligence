/**
 * lib/build-proposal.ts — The proposal assembler (Trading OS v3).
 *
 * Pure, synchronous, no I/O. Turns raw inputs (a quote, caller-chosen
 * entry/stop/target, a regime read, costs) into a complete ProposalCard. It does
 * NOT validate — building and gating are separate concerns. A freshly built card
 * may still fail validateProposalRisk; that's expected and correct.
 *
 * Decoupling: this layer never imports regime.ts. It accepts a structural mirror
 * (RegimeInput) so the proposal pipeline doesn't depend on the indicator engine.
 *
 * Conventions (match the repo): snake_case on persisted-shape fields, round at
 * the return boundary via Number(x.toFixed(n)), never mutate inputs.
 */

import { realisedRR } from './risk-gate';
import type {
  ProposalCard,
  RegimeView,
  RegimeTier,
  RegimeLabel,
  CostModel,
  Expectancy,
  ExitPlan,
  SetupName,
  Direction,
  StrategyHealth,
} from './proposal';
import { sampleConfidence } from './proposal';
import type { Quote } from './feed';

/**
 * Map the engine's regime label to the 1–5 trade tier the gate reads.
 *
 * The regime engine emits a coarse string label and CANNOT distinguish a healthy
 * trend (tier 4) from a true expansion (tier 5) — it has no read on that, so the
 * best it can ever assert is tier 4. Only tiers 4–5 are gate-eligible, so in this
 * validation phase `trending_up` is the SOLE label that yields a tradeable tier.
 * Everything else maps to a blocked tier (fail-safe, long-only):
 *   - volatile -> 3: ambiguous (expansion OR chaos); the engine can't tell, so block.
 *   - ranging  -> 3: no trend edge for this strategy.
 *   - trending_down -> 2: wrong side for a long-only book.
 */
export function mapRegimeToTier(label: RegimeLabel): RegimeTier {
  switch (label) {
    case 'trending_up':
      return 4;
    case 'volatile':
      return 3;
    case 'ranging':
      return 3;
    case 'trending_down':
      return 2;
  }
}

/** Structural mirror of regime.ts's RegimeResult — no import, stays decoupled. */
export interface RegimeInput {
  regime: RegimeLabel;
  adx_14: number;
  atr_ratio: number;
  price_above_ema20: boolean;
  regime_date: string;
}

export function toRegimeView(r: RegimeInput): RegimeView {
  return {
    label: r.regime,
    tier: mapRegimeToTier(r.regime),
    adx_14: r.adx_14,
    atr_ratio: r.atr_ratio,
    price_above_ema20: r.price_above_ema20,
    regime_date: r.regime_date,
  };
}

/**
 * Net-of-cost expectancy in R. Pessimistic by construction: pay entry slippage +
 * half the round-trip fee + half the spread on entry, and assume the FAST-exit
 * slippage (worst case) plus the other fee/spread halves on exit.
 *
 * Degenerate geometry (zero risk distance) returns a result that the gate is
 * guaranteed to reject, rather than NaN/throwing.
 */
export function computeExpectancy(
  entry: number,
  stop: number,
  target: number,
  direction: Direction,
  costs: CostModel,
): Expectancy {
  const risk_per_unit = Math.abs(entry - stop);
  if (risk_per_unit === 0) {
    return { gross_r: 0, cost_r: Infinity, net_r: -Infinity };
  }

  const gross_r = realisedRR(entry, target, stop, direction);

  const entry_drag = costs.entry_slippage_pct + costs.fee_pct / 2 + costs.spread_pct / 2;
  const exit_drag = costs.fast_exit_slippage_pct + costs.fee_pct / 2 + costs.spread_pct / 2;
  const cost_per_unit = entry * entry_drag + target * exit_drag;

  const cost_r = cost_per_unit / risk_per_unit;
  const net_r = gross_r - cost_r;

  return {
    gross_r: Number(gross_r.toFixed(3)),
    cost_r: Number(cost_r.toFixed(3)),
    net_r: Number(net_r.toFixed(3)),
  };
}

export interface BuildProposalInput {
  proposal_id: string;
  symbol: string;
  asset_class: ProposalCard['asset_class'];
  setup: SetupName;
  direction: Direction;
  quote: Quote; // entry reference + freshness source
  entry_price: number; // caller-supplied (limit), not the raw quote
  stop_price: number; // caller-supplied (structure/ATR)
  target_price: number; // caller-supplied
  regime: RegimeInput;
  quality_score: number; // 1..10, caller/quality-engine supplied
  setup_sample_size: number;
  strategy_health: StrategyHealth;
  capital: number;
  risk_pct: number; // intended fraction, e.g. 0.005
  currency: string;
  correlation_cluster: string;
  cluster_risk_pct_after: number;
  current_drawdown_pct: number;
  expected_hold_days: number;
  costs: CostModel;
  ai_thesis: string;
  trail_activate_r?: number; // default 1.0
  time_stop_days?: number; // default 7
  thesis_invalidation?: string[]; // default ['regime drops below tier 4']
  created_at?: number; // default Date.now()
  expiry_minutes?: number; // default 15
  max_chase_pct?: number; // default 0.003
}

export function buildProposal(input: BuildProposalInput): ProposalCard {
  const created_at = input.created_at ?? Date.now();
  const expiry_minutes = input.expiry_minutes ?? 15;

  const regime = toRegimeView(input.regime);

  // --- Position sizing (matches lib/trading.ts rounding convention) ----------
  const risk_amount = Number((input.capital * input.risk_pct).toFixed(2));
  const risk_per_unit = Math.abs(input.entry_price - input.stop_price);
  const position_size =
    risk_per_unit > 0 ? Number((risk_amount / risk_per_unit).toFixed(8)) : 0;

  const expectancy = computeExpectancy(
    input.entry_price,
    input.stop_price,
    input.target_price,
    input.direction,
    input.costs,
  );

  const exit: ExitPlan = {
    stop_price: input.stop_price,
    target_price: input.target_price,
    trail_activate_r: input.trail_activate_r ?? 1.0,
    time_stop_days: input.time_stop_days ?? 7,
    thesis_invalidation: input.thesis_invalidation ?? ['regime drops below tier 4'],
  };

  return {
    proposal_id: input.proposal_id,
    created_at,
    expires_at: created_at + expiry_minutes * 60_000,

    asset_class: input.asset_class,
    symbol: input.symbol,
    setup: input.setup,
    direction: input.direction,

    regime,
    quality_score: input.quality_score,
    sample_confidence: sampleConfidence(input.setup_sample_size),
    setup_sample_size: input.setup_sample_size,
    strategy_health: input.strategy_health,

    entry_price: input.entry_price,
    max_chase_pct: input.max_chase_pct ?? 0.003,

    exit,
    expectancy,

    position_size,
    risk_amount,
    risk_pct: input.risk_pct,
    currency: input.currency,

    correlation_cluster: input.correlation_cluster,
    cluster_risk_pct_after: input.cluster_risk_pct_after,
    current_drawdown_pct: input.current_drawdown_pct,

    expected_hold_days: input.expected_hold_days,
    ai_thesis: input.ai_thesis,
  };
}
