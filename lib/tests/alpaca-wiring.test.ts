import { describe, it, expect } from 'vitest';
import {
  atr14FromBars,
  computeGeometry,
  buildRegimeFromBars,
  buildRealProposalInput,
  postEntryBars,
} from '../propose';
import { buildProposal, toRegimeView } from '../build-proposal';
import { validateProposalRisk } from '../risk-gate';
import { realisedRR } from '../risk-gate';
import { scoreQuality, MIN_QUALITY } from '../quality';
import { FixtureFeed } from '../feeds/fixture';
import type { MarketFeed, Bar } from '../feed';
import type { PortfolioContext } from '../proposal';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1); // distinct calendar day per bar index

function bar(i: number, o: number, h: number, l: number, c: number): Bar {
  return { t: BASE + i * DAY, o, h, l, c, v: 1000 };
}

/**
 * A strong, steady uptrend: each day's close rises by 1, range fixed at ±0.5.
 * Yields +DM=1 / -DM=0 (ADX→~100), price above EMA20, ATR a constant 1.5 (so
 * the geometry rounds cleanly). calculateRegime labels this 'trending_up'.
 */
function trendingBars(n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i;
    out.push(bar(i, close - 0.5, close + 0.5, close - 0.5, close));
  }
  return out;
}

/**
 * A high-QUALITY trend-pullback series for the gate-pass test: a steady uptrend
 * into a shallow ~40% pullback that holds above a rising MA, on megacap $ volume.
 * Since buildRealProposalInput now scores quality from these bars (was hardcoded
 * 8), the gate-pass test needs bars that genuinely score >= MIN_QUALITY — a thin,
 * extended straight line correctly scores ~5 and would now be BLOCKED.
 */
function qualityPullbackBars(n: number, vol = 60_000_000): Bar[] {
  const out: Bar[] = [];
  const pullbackBars = 4;
  const peakIdx = n - pullbackBars - 1;
  for (let i = 0; i <= peakIdx; i++) {
    const c = 100 + i;
    out.push({ t: BASE + i * DAY, o: c - 0.6, h: c + 0.6, l: c - 0.6, c, v: vol });
  }
  const peak = 100 + peakIdx;
  const drop = 0.4 * 20;
  for (let k = 1; k <= pullbackBars; k++) {
    const c = peak - drop * (k / pullbackBars);
    out.push({ t: BASE + (peakIdx + k) * DAY, o: c + 0.3, h: c + 0.6, l: c - 0.6, c, v: vol });
  }
  return out;
}

function cleanCtx(): PortfolioContext {
  return {
    total_open_risk_pct: 0,
    cluster_risk_pct: 0,
    trades_this_week: 0,
    consecutive_losses: 0,
    current_drawdown_pct: 0,
    strategy_health: 'green',
    data_integrity_ok: true,
    in_macro_blackout: false,
    earnings_in_window: false,
  };
}

/** Minimal in-test MarketFeed: fixed bars + a fixed quote price. */
function mockFeed(bars: Bar[], price: number): MarketFeed {
  return {
    assetClass: 'us_equity',
    async getBars() {
      return bars;
    },
    async getQuote() {
      return { symbol: 'AAPL', price, asOf: BASE + 100 * DAY, prevClose: price - 1 };
    },
  };
}

// ---- atr14FromBars (Wilder, known series) ----------------------------------
describe('atr14FromBars', () => {
  it('returns the constant TR for an identical-bar series (ATR = 2)', () => {
    // o=100,h=101,l=99,c=100 -> TR = max(2, |101-100|, |99-100|) = 2 every bar.
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100));
    expect(atr14FromBars(bars)).toBeCloseTo(2, 10);
  });

  it('applies Wilder smoothing on the 15th TR (known value 2.5)', () => {
    // 15 bars TR=2, then a 16th bar with TR=9: (2*13 + 9)/14 = 2.5.
    const bars = Array.from({ length: 15 }, (_, i) => bar(i, 100, 101, 99, 100));
    bars.push(bar(15, 100, 109, 100, 105)); // h-l=9, |h-prevC=100|=9 -> TR=9
    expect(atr14FromBars(bars)).toBeCloseTo(2.5, 10);
  });

  it('throws when there are too few bars to seed the average', () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100, 101, 99, 100));
    expect(() => atr14FromBars(bars)).toThrow(/need >= 15/i);
  });
});

// ---- computeGeometry --------------------------------------------------------
describe('computeGeometry', () => {
  it('entry 100, atr 2 -> stop 97, target 106, exactly 2R', () => {
    const { stop, target } = computeGeometry(100, 2);
    expect(stop).toBe(97); // 100 - 1.5*2
    expect(target).toBe(106); // 100 + 2*(1.5*2)
    expect(stop).toBeLessThan(100);
    expect(target).toBeGreaterThan(100);
    expect(realisedRR(100, target, stop, 'long')).toBeCloseTo(2, 10);
  });

  it('preserves >= 2R after 2dp rounding for an awkward entry/atr', () => {
    // entry 247.33 / atr 1.337 realised only 1.995R under naive independent
    // stop+target rounding — a false sub-2R. The target is now derived from the
    // rounded stop and rounded UP, so realised R:R never falls below 2.0.
    const { stop, target } = computeGeometry(247.33, 1.337);
    expect(realisedRR(247.33, target, stop, 'long')).toBeGreaterThanOrEqual(2 - 1e-9);
  });
});

// ---- buildRegimeFromBars (reuses regime.ts) --------------------------------
describe('buildRegimeFromBars', () => {
  it('maps a trending_up series -> RegimeInput at tier 4 (gate-eligible)', async () => {
    const feed = new FixtureFeed('us_equity', { AAPL: trendingBars(60) }, {});
    const regimeInput = await buildRegimeFromBars('AAPL', feed);

    expect(regimeInput.regime).toBe('trending_up');
    expect(regimeInput.price_above_ema20).toBe(true);
    expect(regimeInput.adx_14).toBeGreaterThan(25);
    // flows through the same mapping the gate reads
    expect(toRegimeView(regimeInput).tier).toBe(4);
  });
});

// ---- buildRealProposalInput -------------------------------------------------
describe('buildRealProposalInput', () => {
  it('produces a card that PASSES the gate with clean ctx (real entry/regime/ATR/quality)', async () => {
    const bars = qualityPullbackBars(60);
    const feed = mockFeed(bars, 200);
    const a = await buildRealProposalInput('AAPL', 'chat', 'user', feed);

    // real entry from the quote; geometry derived from the bars' real ATR
    expect(a.build.entry_price).toBe(200);
    const { stop, target } = computeGeometry(200, atr14FromBars(bars));
    expect(a.build.stop_price).toBe(stop);
    expect(a.build.target_price).toBe(target);
    expect(a.build.regime.regime).toBe('trending_up');

    // quality is REAL now (not hardcoded 8): the card carries scoreQuality(bars)
    // and it clears MIN_QUALITY, which is WHY the gate passes.
    expect(a.build.quality_score).toBe(scoreQuality(bars).score);
    expect(a.build.quality_score).toBeGreaterThanOrEqual(MIN_QUALITY);

    // build the card the same way runProposal would, then gate it
    const quote = await feed.getQuote('AAPL');
    const card = buildProposal({ ...a.build, symbol: a.symbol, quote });
    const gate = validateProposalRisk({ card, ctx: a.ctx });
    expect(gate.passed).toBe(true);
    expect(gate.blocks).toEqual([]);

    // the feed is threaded through for runProposal to reuse
    expect(a.feed).toBe(feed);
  });

  it('BLOCKS a low-quality tier-4 setup: trending regime but extended/thin bars', async () => {
    // Same trending_up regime, but a thin-volume straight line with NO pullback —
    // scores < MIN_QUALITY. This is the engine making the system selective: a
    // valid regime is no longer enough; the setup geometry must also be clean.
    const bars = trendingBars(60); // v=1000 (thin), extended at the high
    const feed = mockFeed(bars, 200);
    const a = await buildRealProposalInput('AAPL', 'chat', 'user', feed);

    expect(a.build.regime.regime).toBe('trending_up'); // regime IS eligible
    expect(a.build.quality_score).toBe(scoreQuality(bars).score);
    expect(a.build.quality_score).toBeLessThan(MIN_QUALITY); // but quality is not

    const quote = await feed.getQuote('AAPL');
    const card = buildProposal({ ...a.build, symbol: a.symbol, quote });
    const gate = validateProposalRisk({ card, ctx: a.ctx });
    expect(gate.passed).toBe(false);
    expect(gate.blocks.map((b) => b.code)).toContain('quality_below_min');
  });

  it('throws if the quote price is 0 (zero-price double-check, fail-closed)', async () => {
    const feed = mockFeed(trendingBars(60), 0);
    await expect(buildRealProposalInput('AAPL', 'chat', 'user', feed)).rejects.toThrow(
      /no valid entry price/i,
    );
  });
});

// ---- postEntryBars (shadow tracker forward bars) ---------------------------
describe('postEntryBars', () => {
  it('keeps only bars STRICTLY after created_at', () => {
    const bars = [bar(0, 1, 1, 1, 1), bar(1, 2, 2, 2, 2), bar(2, 3, 3, 3, 3)];
    const createdAt = bars[1].t; // entry == bar[1]
    const post = postEntryBars(bars, createdAt);
    expect(post).toHaveLength(1);
    expect(post[0].t).toBe(bars[2].t);
  });

  it('returns [] when no bars are post-entry yet (shadow stays open)', () => {
    const bars = [bar(0, 1, 1, 1, 1), bar(1, 2, 2, 2, 2)];
    expect(postEntryBars(bars, bars[1].t)).toEqual([]);
  });
});
