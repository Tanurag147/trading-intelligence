/**
 * lib/proposal.ts — The Phase 1 contract.
 *
 * In-memory only. No persistence, no broker, no Supabase. This file defines what
 * a fully-formed, risk-validated proposal IS. If these types are right, the
 * migrations later are trivial; if they're wrong, persisting them just locks in
 * the mistake. That's why we prove this compiles + tests green first.
 *
 * Naming: snake_case on persisted-shaped fields to mirror the existing DB
 * convention (RegimeResult, trading_positions). camelCase for transient/compute
 * fields that never hit a column.
 */

import type { AssetClass } from './feed';

// ----------------------------------------------------------------------------
// Regime adapter — the engine outputs string labels; v3 gates on a 1–5 tier.
// We map, we don't rewrite regime.ts.
// ----------------------------------------------------------------------------

export type RegimeLabel = 'trending_up' | 'trending_down' | 'ranging' | 'volatile';

/** 1=panic 2=bearish 3=range 4=healthy_trend 5=expansion. Trade only in 4–5. */
export type RegimeTier = 1 | 2 | 3 | 4 | 5;

export interface RegimeView {
  label: RegimeLabel; // raw from lib/regime.ts
  tier: RegimeTier; // mapped — the gate reads this
  adx_14: number;
  atr_ratio: number;
  price_above_ema20: boolean;
  regime_date: string; // 'YYYY-MM-DD'
}

// ----------------------------------------------------------------------------
// Setup taxonomy — Phase 1 ships ONE strategy (trend pullback), but the type
// is open so adding setups later doesn't change the contract.
// ----------------------------------------------------------------------------

export type SetupName =
  | 'trend_pullback'
  | 'breakout_continuation'
  | 'range_fade'
  | 'reversal_sweep'
  | 'momentum_thrust';

export type Direction = 'long' | 'short';

// ----------------------------------------------------------------------------
// Exit plan — every proposal carries all five exit dimensions (Exit Engine).
// Shared by live AND shadow trades so "would_have_*" uses identical logic.
// ----------------------------------------------------------------------------

export interface ExitPlan {
  stop_price: number;
  target_price: number;
  /** R at which stop moves to breakeven / trail activates. Default 1.0. */
  trail_activate_r: number;
  /** Exit if no meaningful move within this many trading days. */
  time_stop_days: number;
  /** Human-readable invalidation conditions (regime drop, structure break…). */
  thesis_invalidation: string[];
}

// ----------------------------------------------------------------------------
// Cost model — net expectancy, never gross. Pessimistic defaults in paper phase.
// ----------------------------------------------------------------------------

export interface CostModel {
  entry_slippage_pct: number; // e.g. 0.0005 (0.05%)
  stop_slippage_pct: number; // e.g. 0.0015
  fast_exit_slippage_pct: number; // e.g. 0.0025
  fee_pct: number; // round-trip taker/maker estimate
  spread_pct: number;
}

export interface Expectancy {
  gross_r: number; // planned R:R, before costs
  cost_r: number; // total cost expressed in R (positive number = drag)
  net_r: number; // gross_r - cost_r — this is what the gate checks
}

// ----------------------------------------------------------------------------
// Sample confidence — defined tiers so the card never shows authoritative win
// rates on tiny n.
// ----------------------------------------------------------------------------

export type SampleConfidence = 'insufficient' | 'low' | 'moderate' | 'meaningful';

export function sampleConfidence(n: number): SampleConfidence {
  if (n < 10) return 'insufficient';
  if (n < 30) return 'low';
  if (n < 100) return 'moderate';
  return 'meaningful';
}

export type StrategyHealth = 'green' | 'yellow' | 'red';

// ----------------------------------------------------------------------------
// PROPOSAL CARD — the full object the founder sees. Self-contained: everything
// needed to decide is on the card (no hidden data).
// ----------------------------------------------------------------------------

export interface ProposalCard {
  proposal_id: string;
  created_at: number; // epoch ms
  expires_at: number; // epoch ms — default created_at + 15min

  asset_class: AssetClass;
  symbol: string;
  setup: SetupName;
  direction: Direction;

  regime: RegimeView;
  quality_score: number; // 1–10
  sample_confidence: SampleConfidence;
  setup_sample_size: number; // n behind the win rate
  strategy_health: StrategyHealth;

  entry_price: number;
  /** Max % beyond entry we'll still execute at; past this the proposal voids. */
  max_chase_pct: number; // default 0.003 (0.3%)

  exit: ExitPlan;
  expectancy: Expectancy;

  position_size: number; // units/shares
  risk_amount: number; // currency
  risk_pct: number; // fraction of capital, e.g. 0.005
  currency: string; // 'USD' | 'AUD' — value-level, columns stay *_aud

  /** Cluster this symbol belongs to, for correlation accounting. */
  correlation_cluster: string;
  /** Total cluster risk % AFTER this fill, for the card's "Correlation Impact". */
  cluster_risk_pct_after: number;
  current_drawdown_pct: number;

  expected_hold_days: number;
  /** Claude-generated rationale. Founder thesis is captured at decision time. */
  ai_thesis: string;
}

// ----------------------------------------------------------------------------
// RISK GATE — pure validation. Takes a candidate + portfolio context, returns
// pass/fail with EVERY reason (not first-fail), so the card can show all blocks.
// ----------------------------------------------------------------------------

/** Hard limits. Defaults encode the v3 spec; all overridable as config knobs. */
export interface RiskLimits {
  max_risk_per_trade_pct: number; // 0.005
  max_total_open_risk_pct: number; // 0.02
  max_cluster_risk_pct: number; // 0.015
  max_trades_per_week: number; // 5
  min_rr: number; // 2.0
  min_net_expectancy_r: number; // 0.25  (calibration knob)
  min_quality_score: number; // 8 (validation phase)
  allowed_regime_tiers: RegimeTier[]; // [4, 5]
}

export const DEFAULT_LIMITS: RiskLimits = {
  max_risk_per_trade_pct: 0.005,
  max_total_open_risk_pct: 0.02,
  max_cluster_risk_pct: 0.015,
  max_trades_per_week: 5,
  min_rr: 2.0,
  min_net_expectancy_r: 0.25,
  min_quality_score: 8,
  allowed_regime_tiers: [4, 5],
};

/** Live portfolio context the gate needs — supplied by caller, not fetched here. */
export interface PortfolioContext {
  total_open_risk_pct: number; // sum of open-position risk
  cluster_risk_pct: number; // existing risk in THIS proposal's cluster
  trades_this_week: number;
  consecutive_losses: number;
  current_drawdown_pct: number;
  strategy_health: StrategyHealth;
  /** Data Integrity Guard already passed upstream? Gate refuses if false. */
  data_integrity_ok: boolean;
  /** True if symbol is inside a macro blackout (24h pre FOMC/CPI/NFP). */
  in_macro_blackout: boolean;
  /** True if symbol has earnings inside the expected hold window. */
  earnings_in_window: boolean;
}

export interface RiskGateInput {
  card: ProposalCard;
  ctx: PortfolioContext;
  limits?: Partial<RiskLimits>;
}

/** Stable machine-readable codes so blocks are loggable + analysable. */
export type RiskBlockCode =
  | 'data_integrity_failed'
  | 'regime_not_eligible'
  | 'quality_below_min'
  | 'rr_below_min'
  | 'net_expectancy_below_min'
  | 'risk_per_trade_exceeded'
  | 'total_open_risk_exceeded'
  | 'cluster_risk_exceeded'
  | 'weekly_trade_cap_reached'
  | 'consecutive_loss_halt'
  | 'macro_blackout'
  | 'earnings_in_window'
  | 'strategy_health_red'
  | 'expired'
  | 'invalid_geometry';

export interface RiskBlock {
  code: RiskBlockCode;
  detail: string;
}

export interface RiskGateResult {
  passed: boolean;
  blocks: RiskBlock[]; // empty iff passed
  /** Echo of the limits actually applied (defaults merged) — for the audit trail. */
  applied_limits: RiskLimits;
  evaluated_at: number;
}
