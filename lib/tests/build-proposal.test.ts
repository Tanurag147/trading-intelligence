import { describe, it, expect } from 'vitest';
import {
  mapRegimeToTier,
  toRegimeView,
  computeExpectancy,
  buildProposal,
  type BuildProposalInput,
  type RegimeInput,
} from '../build-proposal';
import { validateProposalRisk, realisedRR } from '../risk-gate';
import type { CostModel } from '../proposal';
import type { Quote } from '../feed';
import { cleanCtx } from './factory';

// Pessimistic-but-passable cost model: leaves net_r well above the 0.25R floor
// on a 2.5RR card.
const COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
};

function quote(symbol = 'AAPL', price = 100): Quote {
  return { symbol, price, asOf: 1_700_000_000_000, prevClose: 99.5 };
}

function trendingRegime(over: Partial<RegimeInput> = {}): RegimeInput {
  return {
    regime: 'trending_up',
    adx_14: 31.2,
    atr_ratio: 1.05,
    price_above_ema20: true,
    regime_date: '2026-06-22',
    ...over,
  };
}

// A clean long build that should pass the gate: entry 100, stop 98, target 105
// (RR 2.5), risk_pct 0.005, quality 8, trending_up.
function buildInput(over: Partial<BuildProposalInput> = {}): BuildProposalInput {
  return {
    proposal_id: 'p_build_0001',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
    quote: quote(),
    entry_price: 100,
    stop_price: 98,
    target_price: 105,
    regime: trendingRegime(),
    quality_score: 8,
    setup_sample_size: 12,
    strategy_health: 'green',
    capital: 2500,
    risk_pct: 0.005,
    currency: 'USD',
    correlation_cluster: 'megacap_tech',
    cluster_risk_pct_after: 0.005,
    current_drawdown_pct: 0.0,
    expected_hold_days: 5,
    costs: COSTS,
    ai_thesis: 'Pullback to rising 20EMA in confirmed uptrend.',
    ...over,
  };
}

describe('mapRegimeToTier', () => {
  it('maps all four labels to the fail-safe tiers', () => {
    expect(mapRegimeToTier('trending_up')).toBe(4);
    expect(mapRegimeToTier('volatile')).toBe(3);
    expect(mapRegimeToTier('ranging')).toBe(3);
    expect(mapRegimeToTier('trending_down')).toBe(2);
  });

  it('toRegimeView copies fields and applies the tier', () => {
    const v = toRegimeView(trendingRegime({ adx_14: 28.4 }));
    expect(v.label).toBe('trending_up');
    expect(v.tier).toBe(4);
    expect(v.adx_14).toBe(28.4);
    expect(v.price_above_ema20).toBe(true);
    expect(v.regime_date).toBe('2026-06-22');
  });
});

describe('builder emits gate-valid cards', () => {
  it('a trending_up build => tier 4 and PASSES validateProposalRisk unmodified', () => {
    const card = buildProposal(buildInput());
    expect(card.regime.tier).toBe(4);
    const gate = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(gate.passed).toBe(true);
    expect(gate.blocks).toEqual([]);
  });

  it('a ranging build => tier 3 and is BLOCKED regime_not_eligible', () => {
    const card = buildProposal(buildInput({ regime: trendingRegime({ regime: 'ranging' }) }));
    expect(card.regime.tier).toBe(3);
    const gate = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(gate.passed).toBe(false);
    expect(gate.blocks.map((b) => b.code)).toContain('regime_not_eligible');
  });
});

describe('position sizing', () => {
  it('capital 2500, risk_pct 0.005, entry 100, stop 98 => risk 12.5, size 6.25', () => {
    const card = buildProposal(buildInput({ capital: 2500, risk_pct: 0.005 }));
    expect(card.risk_amount).toBe(12.5);
    expect(card.position_size).toBe(6.25);
  });

  it('degenerate geometry => position_size 0', () => {
    const card = buildProposal(buildInput({ stop_price: 100 })); // entry === stop
    expect(card.position_size).toBe(0);
  });
});

describe('computeExpectancy', () => {
  it('net_r is always below gross_r (costs are a drag)', () => {
    const e = computeExpectancy(100, 98, 105, 'long', COSTS);
    expect(e.cost_r).toBeGreaterThan(0);
    expect(e.net_r).toBeLessThan(e.gross_r);
  });

  it('a wide stop has lower cost_r than a tight stop (same costs)', () => {
    const wide = computeExpectancy(100, 90, 130, 'long', COSTS); // risk_per_unit 10
    const tight = computeExpectancy(100, 99, 103, 'long', COSTS); // risk_per_unit 1
    expect(wide.cost_r).toBeLessThan(tight.cost_r);
  });

  it('degenerate geometry => net_r -Infinity, cost_r Infinity', () => {
    const e = computeExpectancy(100, 100, 105, 'long', COSTS);
    expect(e.gross_r).toBe(0);
    expect(e.cost_r).toBe(Infinity);
    expect(e.net_r).toBe(-Infinity);
  });

  it('degenerate-geometry card is rejected by the gate', () => {
    const card = buildProposal(buildInput({ stop_price: 100 }));
    const gate = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(gate.passed).toBe(false);
    const codes = gate.blocks.map((b) => b.code);
    expect(codes.some((c) => c === 'invalid_geometry' || c === 'net_expectancy_below_min')).toBe(true);
  });
});

describe('expiry', () => {
  it('default expires_at == created_at + 15min', () => {
    const created_at = 1_700_000_000_000;
    const card = buildProposal(buildInput({ created_at }));
    expect(card.expires_at).toBe(created_at + 15 * 60_000);
  });

  it('expiry_minutes:30 is honored', () => {
    const created_at = 1_700_000_000_000;
    const card = buildProposal(buildInput({ created_at, expiry_minutes: 30 }));
    expect(card.expires_at).toBe(created_at + 30 * 60_000);
  });
});

describe('internal consistency', () => {
  it('realisedRR(card geometry) equals expectancy.gross_r', () => {
    const card = buildProposal(buildInput());
    const rr = realisedRR(card.entry_price, card.exit.target_price, card.exit.stop_price, card.direction);
    expect(card.expectancy.gross_r).toBeCloseTo(rr, 3);
  });

  it('sample_confidence reflects the sample size', () => {
    expect(buildProposal(buildInput({ setup_sample_size: 5 })).sample_confidence).toBe('insufficient');
    expect(buildProposal(buildInput({ setup_sample_size: 50 })).sample_confidence).toBe('moderate');
  });
});

describe('purity', () => {
  it('does not mutate the input object', () => {
    const input = buildInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    buildProposal(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});
