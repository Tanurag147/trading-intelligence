/**
 * lib/risk-gate.ts — Pure, synchronous, no I/O. Given a fully-formed card and
 * portfolio context, decide whether this trade DESERVES CAPITAL under the rules.
 *
 * Design rules:
 *  - Collect ALL blocks, never first-fail. The founder + decision log want the
 *    complete reason set.
 *  - Fail closed. Anything ambiguous (bad geometry, stale, integrity off) blocks.
 *  - No mutation of inputs. No fetching. Caller supplies context.
 *  - This same purity lets the Shadow Tracker reuse it on phantom cards.
 */

import {
  type RiskGateInput,
  type RiskGateResult,
  type RiskBlock,
  type RiskLimits,
  type ProposalCard,
  type Direction,
  DEFAULT_LIMITS,
} from './proposal';

/** Realised R:R from geometry. Negative/zero risk distance => NaN (caught). */
export function realisedRR(
  entry: number,
  target: number,
  stop: number,
  direction: Direction,
): number {
  const risk = Math.abs(entry - stop);
  if (risk === 0) return NaN;
  const reward = direction === 'long' ? target - entry : entry - target;
  return reward / risk;
}

/** Validates the basic geometry of a card: stop/target on the correct sides. */
export function geometryValid(card: ProposalCard): boolean {
  const { entry_price: e, direction } = card;
  const { stop_price: s, target_price: t } = card.exit;
  if (![e, s, t].every((n) => Number.isFinite(n) && n > 0)) return false;
  if (direction === 'long') return s < e && t > e;
  return s > e && t < e; // short
}

function mergeLimits(overrides?: Partial<RiskLimits>): RiskLimits {
  return { ...DEFAULT_LIMITS, ...(overrides ?? {}) };
}

export function validateProposalRisk(input: RiskGateInput): RiskGateResult {
  const { card, ctx } = input;
  const limits = mergeLimits(input.limits);
  const blocks: RiskBlock[] = [];
  const now = Date.now();

  const add = (code: RiskBlock['code'], detail: string) =>
    blocks.push({ code, detail });

  // --- Fail-closed preconditions -------------------------------------------
  if (!ctx.data_integrity_ok) {
    add('data_integrity_failed', 'Data Integrity Guard did not pass; no proposal is valid.');
  }
  if (card.expires_at <= now) {
    add('expired', `Proposal expired at ${new Date(card.expires_at).toISOString()}.`);
  }
  if (!geometryValid(card)) {
    add(
      'invalid_geometry',
      'Stop/target are not on the correct sides of entry, or a price is non-positive.',
    );
  }

  // --- Regime gate ----------------------------------------------------------
  if (!limits.allowed_regime_tiers.includes(card.regime.tier)) {
    add(
      'regime_not_eligible',
      `Regime tier ${card.regime.tier} (${card.regime.label}) not in [${limits.allowed_regime_tiers.join(',')}].`,
    );
  }

  // --- Quality --------------------------------------------------------------
  if (card.quality_score < limits.min_quality_score) {
    add(
      'quality_below_min',
      `Quality ${card.quality_score} < required ${limits.min_quality_score}.`,
    );
  }

  // --- R:R from geometry (independent of the card's claimed gross_r) ---------
  // Tolerate a tiny epsilon below min_rr: prices are rounded to 2dp, so an
  // exactly-min_rr trade can realise e.g. 1.9999999998R from float division.
  // Without this, a valid exactly-2R geometry is a false-negative block. (The
  // geometry builder also rounds the target UP so the structural R:R is >=
  // min_rr; this epsilon only absorbs the residual float noise.)
  const RR_EPSILON = 1e-9;
  const rr = realisedRR(card.entry_price, card.exit.target_price, card.exit.stop_price, card.direction);
  if (!Number.isFinite(rr) || rr < limits.min_rr - RR_EPSILON) {
    add('rr_below_min', `R:R ${Number.isFinite(rr) ? rr.toFixed(2) : 'NaN'} < required ${limits.min_rr}.`);
  }

  // --- Net expectancy (the cost-adjusted edge) ------------------------------
  if (card.expectancy.net_r < limits.min_net_expectancy_r) {
    add(
      'net_expectancy_below_min',
      `Net expectancy ${card.expectancy.net_r.toFixed(3)}R < required ${limits.min_net_expectancy_r}R.`,
    );
  }

  // --- Per-trade risk -------------------------------------------------------
  if (card.risk_pct > limits.max_risk_per_trade_pct + 1e-9) {
    add(
      'risk_per_trade_exceeded',
      `Trade risk ${(card.risk_pct * 100).toFixed(2)}% > max ${(limits.max_risk_per_trade_pct * 100).toFixed(2)}%.`,
    );
  }

  // --- Total open risk AFTER this fill --------------------------------------
  const totalAfter = ctx.total_open_risk_pct + card.risk_pct;
  if (totalAfter > limits.max_total_open_risk_pct + 1e-9) {
    add(
      'total_open_risk_exceeded',
      `Open risk after fill ${(totalAfter * 100).toFixed(2)}% > max ${(limits.max_total_open_risk_pct * 100).toFixed(2)}%.`,
    );
  }

  // --- Cluster (correlation) risk AFTER this fill ---------------------------
  const clusterAfter = ctx.cluster_risk_pct + card.risk_pct;
  if (clusterAfter > limits.max_cluster_risk_pct + 1e-9) {
    add(
      'cluster_risk_exceeded',
      `Cluster '${card.correlation_cluster}' risk after fill ${(clusterAfter * 100).toFixed(2)}% > max ${(limits.max_cluster_risk_pct * 100).toFixed(2)}%.`,
    );
  }

  // --- Weekly cadence cap ---------------------------------------------------
  if (ctx.trades_this_week >= limits.max_trades_per_week) {
    add(
      'weekly_trade_cap_reached',
      `Already ${ctx.trades_this_week} trades this week (max ${limits.max_trades_per_week}).`,
    );
  }

  // --- Discipline halts -----------------------------------------------------
  if (ctx.consecutive_losses >= 2) {
    add('consecutive_loss_halt', `${ctx.consecutive_losses} consecutive losses; new trades halted pending review.`);
  }
  if (ctx.strategy_health === 'red') {
    add('strategy_health_red', 'Strategy health is RED; proposals paused.');
  }

  // --- Event filters --------------------------------------------------------
  if (ctx.in_macro_blackout) {
    add('macro_blackout', 'Within 24h of a major macro event (FOMC/CPI/NFP).');
  }
  if (ctx.earnings_in_window) {
    add('earnings_in_window', 'Earnings fall inside the expected hold window.');
  }

  return {
    passed: blocks.length === 0,
    blocks,
    applied_limits: limits,
    evaluated_at: now,
  };
}
