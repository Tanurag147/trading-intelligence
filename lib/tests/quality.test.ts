import { describe, it, expect } from 'vitest';
import { scoreQuality, MIN_QUALITY, type QualityBreakdown } from '../quality';
import { buildRealProposalInput } from '../propose';
import type { Bar, MarketFeed } from '../feed';

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 0, 1);

function mk(i: number, o: number, h: number, l: number, c: number, v?: number): Bar {
  return { t: BASE + i * DAY, o, h, l, c, v };
}

/**
 * A clean uptrend that ends in a shallow, orderly pullback holding above a rising
 * MA — the textbook trend-pullback setup. High $ volume (megacap). Rising leg
 * close = 100 + i·1; then a short pullback retracing ~40% of the recent leg.
 */
function cleanPullbackBars(n: number, vol = 60_000_000): Bar[] {
  const out: Bar[] = [];
  const pullbackBars = 4;
  const peakIdx = n - pullbackBars - 1;
  for (let i = 0; i <= peakIdx; i++) {
    const c = 100 + i; // steady uptrend
    out.push(mk(i, c - 0.6, c + 0.6, c - 0.6, c, vol));
  }
  const peak = 100 + peakIdx;
  // recent leg ~ last 20 bars; place the final close ~0.4 retrace of it, still high
  const leg = 20; // ~ window span of the rise
  const totalDrop = 0.4 * leg;
  for (let k = 1; k <= pullbackBars; k++) {
    const c = peak - totalDrop * (k / pullbackBars);
    out.push(mk(peakIdx + k, c + 0.3, c + 0.6, c - 0.6, c, vol));
  }
  return out;
}

/** A broken downtrend: lower highs, lower lows, close below the MA. */
function brokenBars(n: number, vol = 60_000_000): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = 160 - i; // steady downtrend
    out.push(mk(i, c + 0.6, c + 0.6, c - 0.6, c, vol));
  }
  return out;
}

/** A strong uptrend with NO pullback — price extended at the very high. */
function extendedBars(n: number, vol = 60_000_000): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + i;
    out.push(mk(i, c - 0.6, c + 0.6, c - 0.6, c, vol)); // close == high region, last = top
  }
  return out;
}

/**
 * A "merely okay" setup: clean trend/structure/pullback but THIN volume, so
 * exactly one of the four real components (liquidity) is weak. Designed to land a
 * four-component score of 7 — below the MIN_QUALITY=8 bar.
 */
function okayPullbackBars(n: number): Bar[] {
  return cleanPullbackBars(n, 20_000); // ~$3M/day notional → liquidity ~2
}

describe('scoreQuality — clean uptrend + shallow pullback (all four real components high)', () => {
  it('scores ~9 on the four real components and clears the 8 bar', () => {
    const q = scoreQuality(cleanPullbackBars(60));
    expect(q.score).toBeGreaterThanOrEqual(9); // four-component mean of a flawless setup
    expect(q.score).toBeGreaterThanOrEqual(MIN_QUALITY); // PASSES the gate
    expect(q.trend_strength).toBeGreaterThanOrEqual(7);
    expect(q.pullback_quality).toBeGreaterThanOrEqual(7);
    expect(q.liquidity).toBeGreaterThanOrEqual(8); // megacap $ volume
  });
});

describe('scoreQuality — merely-okay pullback (one weak real component)', () => {
  it('lands 7 and is below the 8 threshold (would block)', () => {
    const q = scoreQuality(okayPullbackBars(60));
    expect(q.score).toBe(7); // one weak component (thin liquidity) drops it to 7
    expect(q.score).toBeLessThan(MIN_QUALITY); // BLOCKED at the 8 bar
    expect(q.liquidity).toBeLessThan(4); // the weak component
    expect(q.trend_strength).toBeGreaterThanOrEqual(7); // the rest are fine
    expect(q.pullback_quality).toBeGreaterThanOrEqual(7);
  });
});

describe('scoreQuality — broken / downtrend', () => {
  it('scores low (< 5)', () => {
    const q = scoreQuality(brokenBars(60));
    expect(q.score).toBeLessThan(5);
    expect(q.trend_strength).toBeLessThan(3);
  });
});

describe('scoreQuality — extended (no pullback)', () => {
  it('pullback_quality is low (< 5) even though the trend is strong', () => {
    const q = scoreQuality(extendedBars(60));
    expect(q.pullback_quality).toBeLessThan(5);
    expect(q.trend_strength).toBeGreaterThanOrEqual(7); // trend itself is strong
  });
});

describe('scoreQuality — thin volume', () => {
  it('liquidity is low (< 5)', () => {
    // same clean shape, but ~1k shares/day → ~$100k/day notional
    const q = scoreQuality(cleanPullbackBars(60, 1_000));
    expect(q.liquidity).toBeLessThan(5);
  });
});

describe('scoreQuality — pending placeholders are reported but NOT in score', () => {
  it('sector_strength and market_alignment are exactly 5, flagged pending, and do not move the score', () => {
    const q = scoreQuality(cleanPullbackBars(60));
    expect(q.sector_strength).toBe(5);
    expect(q.market_alignment).toBe(5);
    expect(q.notes.toLowerCase()).toContain('pending');
    expect(q.notes).toContain('sector');
    expect(q.notes).toContain('market');

    // proof they don't factor in: the score equals the mean of ONLY the four real
    // components, independent of the placeholders' value.
    const fourMean = Math.round(
      (q.trend_strength + q.structure_quality + q.pullback_quality + q.liquidity) / 4,
    );
    expect(q.score).toBe(fourMean);
  });
});

describe('scoreQuality — degenerate input is clamped, never NaN', () => {
  const cases: Array<[string, Bar[]]> = [
    ['empty', []],
    ['one bar', [mk(0, 100, 100, 100, 100, 1000)]],
    ['two flat bars', [mk(0, 100, 100, 100, 100), mk(1, 100, 100, 100, 100)]],
  ];
  for (const [name, bars] of cases) {
    it(`${name}: score is an integer in 1..10`, () => {
      const q: QualityBreakdown = scoreQuality(bars);
      expect(Number.isNaN(q.score)).toBe(false);
      expect(q.score).toBeGreaterThanOrEqual(1);
      expect(q.score).toBeLessThanOrEqual(10);
      expect(Number.isInteger(q.score)).toBe(true);
      // no sub-score is ever NaN
      for (const v of [
        q.trend_strength,
        q.structure_quality,
        q.pullback_quality,
        q.liquidity,
      ]) {
        expect(Number.isNaN(v)).toBe(false);
      }
    });
  }
});

describe('scoreQuality — four-component default, six-component opt-in', () => {
  it('default scores the four real components; the legacy six-component mode scores lower for a strong setup', () => {
    const def = scoreQuality(cleanPullbackBars(60)); // DEFAULT = four real
    const six = scoreQuality(cleanPullbackBars(60), { includePendingPlaceholders: true });
    // a strong setup scores HIGHER under the four-real default than when the two
    // pinned-at-5 placeholders drag the mean toward the 8.33 ceiling
    expect(def.score).toBeGreaterThan(six.score);
    expect(def.notes.toLowerCase()).toContain('pending');
    expect(six.notes).toContain('all six');
  });
});

describe('MIN_QUALITY', () => {
  it('mirrors the gate default of 8', () => {
    expect(MIN_QUALITY).toBe(8);
  });
});

describe('buildRealProposalInput wiring — uses the REAL score, not hardcoded 8', () => {
  function mockFeed(bars: Bar[], price: number): MarketFeed {
    return {
      assetClass: 'us_equity',
      async getBars() {
        return bars;
      },
      async getQuote() {
        return { symbol: 'AAPL', price, asOf: BASE, prevClose: price - 1 };
      },
    };
  }

  it('puts scoreQuality(bars).score on the card (clean setup → not the old fixed 8 by accident)', async () => {
    const bars = scoreQuality(cleanPullbackBars(60)); // sanity that the helper scores
    expect(bars.score).toBeGreaterThanOrEqual(7);

    const series = cleanPullbackBars(60);
    const a = await buildRealProposalInput('AAPL', 'chat', 'user', mockFeed(series, 200));
    expect(a.build.quality_score).toBe(scoreQuality(series).score);
  });

  it('a thin/extended series lands a DIFFERENT, lower score than 8 (proves it is not hardcoded)', async () => {
    const series = extendedBars(60, 1_000); // thin + extended → real score < 8
    const real = scoreQuality(series).score;
    expect(real).toBeLessThan(8);

    const a = await buildRealProposalInput('AAPL', 'chat', 'user', mockFeed(series, 200));
    expect(a.build.quality_score).toBe(real);
  });
});
