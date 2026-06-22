/**
 * lib/__tests__/factory.ts — builders so each test tweaks ONE thing from a known
 * good baseline. A clean long trend-pullback that passes every gate.
 */

import type { ProposalCard, PortfolioContext, RegimeView } from '../proposal';

export function cleanRegime(over: Partial<RegimeView> = {}): RegimeView {
  return {
    label: 'trending_up',
    tier: 4,
    adx_14: 31.2,
    atr_ratio: 1.05,
    price_above_ema20: true,
    regime_date: '2026-06-22',
    ...over,
  };
}

export function cleanCard(over: Partial<ProposalCard> = {}): ProposalCard {
  const now = Date.now();
  const entry = 100;
  const stop = 98; // risk distance 2
  const target = 105; // reward 5 => RR 2.5
  return {
    proposal_id: 'p_test_0001',
    created_at: now,
    expires_at: now + 15 * 60_000,
    asset_class: 'us_equity',
    symbol: 'AAPL',
    setup: 'trend_pullback',
    direction: 'long',
    regime: cleanRegime(),
    quality_score: 8,
    sample_confidence: 'low',
    setup_sample_size: 12,
    strategy_health: 'green',
    entry_price: entry,
    max_chase_pct: 0.003,
    exit: {
      stop_price: stop,
      target_price: target,
      trail_activate_r: 1.0,
      time_stop_days: 7,
      thesis_invalidation: ['regime drops below tier 4', 'loses 50D MA'],
    },
    expectancy: { gross_r: 2.5, cost_r: 0.18, net_r: 2.32 },
    position_size: 6.25,
    risk_amount: 12.5,
    risk_pct: 0.005,
    currency: 'USD',
    correlation_cluster: 'megacap_tech',
    cluster_risk_pct_after: 0.005,
    current_drawdown_pct: 0.0,
    expected_hold_days: 5,
    ai_thesis: 'Pullback to rising 20EMA in confirmed uptrend, sector leading.',
    ...over,
  };
}

export function cleanCtx(over: Partial<PortfolioContext> = {}): PortfolioContext {
  return {
    total_open_risk_pct: 0.005,
    cluster_risk_pct: 0.0,
    trades_this_week: 1,
    consecutive_losses: 0,
    current_drawdown_pct: 0.0,
    strategy_health: 'green',
    data_integrity_ok: true,
    in_macro_blackout: false,
    earnings_in_window: false,
    ...over,
  };
}
