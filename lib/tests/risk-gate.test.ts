import { describe, it, expect } from 'vitest';
import { validateProposalRisk, realisedRR, geometryValid } from '../risk-gate';
import { sampleConfidence } from '../proposal';
import { FixtureFeed } from '../feeds/fixture';
import { cleanCard, cleanCtx } from './factory';

describe('happy path', () => {
  it('passes a clean trend-pullback with no blocks', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx() });
    expect(r.passed).toBe(true);
    expect(r.blocks).toEqual([]);
    expect(r.applied_limits.min_quality_score).toBe(8);
  });
});

describe('fail-closed preconditions', () => {
  it('blocks when data integrity is off', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ data_integrity_ok: false }) });
    expect(r.blocks.map((b) => b.code)).toContain('data_integrity_failed');
  });
  it('blocks an expired proposal', () => {
    const r = validateProposalRisk({ card: cleanCard({ expires_at: Date.now() - 1 }), ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('expired');
  });
  it('blocks invalid geometry (stop above entry on a long)', () => {
    const card = cleanCard();
    card.exit.stop_price = 101; // wrong side
    const r = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('invalid_geometry');
  });
});

describe('regime + quality + edge gates', () => {
  it('blocks non-eligible regime tier', () => {
    const r = validateProposalRisk({ card: cleanCard({ regime: { ...cleanCard().regime, tier: 3, label: 'ranging' } }), ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('regime_not_eligible');
  });
  it('blocks quality below 8', () => {
    const r = validateProposalRisk({ card: cleanCard({ quality_score: 7 }), ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('quality_below_min');
  });
  it('blocks RR below 2 derived from geometry', () => {
    const card = cleanCard();
    card.exit.target_price = 103; // reward 3, risk 2 => RR 1.5
    const r = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('rr_below_min');
  });
  it('does NOT block an exactly-2R trade that lands a float-hair under 2.0', () => {
    // Real 2dp-rounded geometry (entry 256.79, stop 256.03, target 258.31):
    // reward/risk is 2.0 in decimal but 1.9999999999998503 in float — a valid
    // exactly-2R trade. The RR_EPSILON tolerance must let it pass.
    const card = cleanCard();
    card.entry_price = 256.79;
    card.exit.stop_price = 256.03; // risk 0.76
    card.exit.target_price = 258.31; // reward 1.52 => 2.0R (float 1.99999…)
    expect(realisedRR(256.79, 258.31, 256.03, 'long')).toBeLessThan(2); // proves the hazard
    const r = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).not.toContain('rr_below_min');
  });
  it('still blocks a genuine 1.9R (epsilon does not mask real shortfalls)', () => {
    const card = cleanCard();
    card.entry_price = 100;
    card.exit.stop_price = 90; // risk 10
    card.exit.target_price = 119; // reward 19 => 1.9R
    const r = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('rr_below_min');
  });
  it('blocks net expectancy below 0.25R', () => {
    const card = cleanCard();
    card.expectancy = { gross_r: 2.5, cost_r: 2.4, net_r: 0.1 };
    const r = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('net_expectancy_below_min');
  });
});

describe('risk + correlation + cadence', () => {
  it('blocks per-trade risk over 0.5%', () => {
    const r = validateProposalRisk({ card: cleanCard({ risk_pct: 0.01 }), ctx: cleanCtx() });
    expect(r.blocks.map((b) => b.code)).toContain('risk_per_trade_exceeded');
  });
  it('blocks total open risk over 2%', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ total_open_risk_pct: 0.018 }) });
    expect(r.blocks.map((b) => b.code)).toContain('total_open_risk_exceeded');
  });
  it('blocks cluster risk over 1.5%', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ cluster_risk_pct: 0.013 }) });
    expect(r.blocks.map((b) => b.code)).toContain('cluster_risk_exceeded');
  });
  it('blocks weekly cap', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ trades_this_week: 5 }) });
    expect(r.blocks.map((b) => b.code)).toContain('weekly_trade_cap_reached');
  });
});

describe('discipline + event filters', () => {
  it('halts after 2 consecutive losses', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ consecutive_losses: 2 }) });
    expect(r.blocks.map((b) => b.code)).toContain('consecutive_loss_halt');
  });
  it('blocks on RED strategy health', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ strategy_health: 'red' }) });
    expect(r.blocks.map((b) => b.code)).toContain('strategy_health_red');
  });
  it('blocks during macro blackout', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ in_macro_blackout: true }) });
    expect(r.blocks.map((b) => b.code)).toContain('macro_blackout');
  });
  it('blocks when earnings inside hold window', () => {
    const r = validateProposalRisk({ card: cleanCard(), ctx: cleanCtx({ earnings_in_window: true }) });
    expect(r.blocks.map((b) => b.code)).toContain('earnings_in_window');
  });
});

describe('collects ALL blocks, not first-fail', () => {
  it('reports multiple simultaneous failures', () => {
    const card = cleanCard({ quality_score: 5, risk_pct: 0.02 });
    const r = validateProposalRisk({ card, ctx: cleanCtx({ in_macro_blackout: true, consecutive_losses: 3 }) });
    const codes = r.blocks.map((b) => b.code);
    expect(codes).toContain('quality_below_min');
    expect(codes).toContain('risk_per_trade_exceeded');
    expect(codes).toContain('macro_blackout');
    expect(codes).toContain('consecutive_loss_halt');
    expect(r.blocks.length).toBeGreaterThanOrEqual(4);
  });
});

describe('pure helpers', () => {
  it('realisedRR computes long + short', () => {
    expect(realisedRR(100, 105, 98, 'long')).toBeCloseTo(2.5);
    expect(realisedRR(100, 95, 102, 'short')).toBeCloseTo(2.5);
  });
  it('realisedRR returns NaN on zero risk', () => {
    expect(Number.isNaN(realisedRR(100, 105, 100, 'long'))).toBe(true);
  });
  it('geometryValid rejects wrong-side stops', () => {
    const c = cleanCard();
    c.exit.stop_price = 101;
    expect(geometryValid(c)).toBe(false);
  });
});

describe('sample confidence tiers', () => {
  it('maps n to the right band', () => {
    expect(sampleConfidence(0)).toBe('insufficient');
    expect(sampleConfidence(9)).toBe('insufficient');
    expect(sampleConfidence(10)).toBe('low');
    expect(sampleConfidence(29)).toBe('low');
    expect(sampleConfidence(30)).toBe('moderate');
    expect(sampleConfidence(99)).toBe('moderate');
    expect(sampleConfidence(100)).toBe('meaningful');
  });
});

describe('feed adapter is concrete + swappable', () => {
  it('FixtureFeed satisfies MarketFeed', async () => {
    const now = Date.now();
    const feed = new FixtureFeed(
      'us_equity',
      { AAPL: [{ t: now, o: 99, h: 101, l: 98, c: 100 }] },
      { AAPL: { symbol: 'AAPL', price: 100.1, asOf: now, prevClose: 99.5 } },
    );
    const bars = await feed.getBars('AAPL', '1d', 50);
    const q = await feed.getQuote('AAPL');
    expect(bars.length).toBe(1);
    expect(q.price).toBeCloseTo(100.1);
    expect(feed.assetClass).toBe('us_equity');
  });
});
