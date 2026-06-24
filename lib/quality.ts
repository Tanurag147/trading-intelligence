/**
 * lib/quality.ts — The Quality Engine.
 *
 * Turns a series of daily OHLC(V) bars into a 1–10 setup quality score that
 * replaces the hardcoded `quality_score: 8` placeholder in buildRealProposalInput.
 * The card's quality_score is what the risk gate reads via
 * DEFAULT_LIMITS.min_quality_score (default 8) — so this engine is what makes the
 * system selective: a tier-4 trending name with a broken structure or a weak
 * pullback now scores < 8 and is BLOCKED with `quality_below_min`. No gate change
 * is needed; the gate already reads min_quality_score.
 *
 * SIX components, EQUAL weight WHEN ALL ARE REAL. FOUR are computed here from
 * daily bars; TWO are not yet computable and are reported as neutral placeholders:
 *
 *   trend_strength     — computed (EMA20 slope + close-above-EMA consistency)
 *   structure_quality  — computed (higher-high / higher-low swing consistency)
 *   pullback_quality   — computed (retracement depth into a rising MA)
 *   liquidity          — computed (avg daily $ volume)
 *   sector_strength    — PENDING 5 (needs sector-ETF regime data) — NOT in score
 *   market_alignment   — PENDING 5 (needs SPY/QQQ regime data)   — NOT in score
 *
 * SCORING (current default): `score` is the rounded mean of ONLY the FOUR real
 * components — a true 0–10 range. The two pending components are still reported in
 * the breakdown (value 5, flagged "pending") but DO NOT factor into `score`.
 *
 * WHY four, not six: two components frozen at 5 distort a six-component mean — the
 * ceiling becomes (10·4 + 5·2)/6 = 8.33, so the MIN_QUALITY=8 bar would mean
 * "near-perfect only" as an artifact of the placeholders, not a real quality bar.
 * Scoring the four real components keeps the threshold at an honest 8 ("80% on
 * what we actually measure") without eroding discipline by lowering it.
 *
 * MIGRATION POINT — see SCORE_COMPONENT_MODE below: when sector_strength and
 * market_alignment become real, flip the mode to 'six' (a one-line change) so all
 * six factor in, then re-evaluate whether 8 is still the right threshold.
 *
 * PURE: scoreQuality has no I/O. All heuristics are simple, transparent, and
 * documented so a human can audit why a setup scored what it did. This file does
 * NOT touch regime.ts — the regime engine computes its own EMA/ADX/ATR; the
 * quality engine computes its own independent, simpler measures from the bars.
 */

import type { Bar } from './feed';

/** The validation gate value. Mirrors DEFAULT_LIMITS.min_quality_score (8). The
 *  gate reads min_quality_score; this constant documents the intended default and
 *  is the single place to bump the threshold from if calibration says so. */
export const MIN_QUALITY = 8;

export interface QualityBreakdown {
  trend_strength: number; // 0–10 sub-score (computed, IN score)
  structure_quality: number; // 0–10 (computed, IN score)
  pullback_quality: number; // 0–10 (computed, IN score)
  liquidity: number; // 0–10 (computed, IN score)
  sector_strength: number; // PENDING: fixed 5, NOT in score (flagged in notes)
  market_alignment: number; // PENDING: fixed 5, NOT in score (flagged in notes)
  score: number; // 1–10 final (mean of the four real components, rounded, clamped)
  notes: string; // short human summary incl. which components are pending
}

export interface ScoreOptions {
  /**
   * Force the legacy six-component mean (the four real components + the two
   * pending placeholders pinned at 5). Provided for parity/experiments only; the
   * DEFAULT is the four-real-component mean (SCORE_COMPONENT_MODE === 'four').
   * Equivalent to setting mode to 'six' for a single call.
   */
  includePendingPlaceholders?: boolean;
}

/**
 * MIGRATION POINT. Today only four components are real, so `score` is their mean
 * (true 0–10 range, honest 8 threshold). When sector_strength and market_alignment
 * become real, flip this to 'six' — a ONE-LINE change — so all six factor in with
 * equal weight, then re-evaluate MIN_QUALITY / DEFAULT_LIMITS.min_quality_score.
 */
export const SCORE_COMPONENT_MODE: 'four' | 'six' = 'four';

const SECTOR_PLACEHOLDER = 5;
const MARKET_PLACEHOLDER = 5;

// ----------------------------------------------------------------------------
// Tiny numeric helpers (transparent, no dependencies).
// ----------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * EMA over a value series, seeded with the first value (transparent + stable on
 * short series — we deliberately don't require `period` bars to start, so the
 * engine degrades gracefully on a 12-bar fixture instead of throwing).
 */
function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/**
 * Indices of local swing points within a series. A swing high at i means h[i] is
 * the strict max of the window [i-k, i+k]; swing low is the strict min. k small
 * (1) so short fixtures still yield pivots.
 */
function swingValues(vals: number[], k: number, kind: 'high' | 'low'): number[] {
  const out: number[] = [];
  for (let i = k; i < vals.length - k; i++) {
    let isPivot = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (kind === 'high' ? vals[j] >= vals[i] : vals[j] <= vals[i]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) out.push(vals[i]);
  }
  return out;
}

/** Fraction of consecutive steps that increase, over a value series. */
function fractionIncreasing(vals: number[]): number {
  if (vals.length < 2) return 0;
  let up = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] > vals[i - 1]) up++;
  return up / (vals.length - 1);
}

// ----------------------------------------------------------------------------
// The four computed sub-scores. Each takes daily bars (oldest-first) → 0–10.
// ----------------------------------------------------------------------------

/**
 * trend_strength — how cleanly price is in an uptrend. Two equal halves:
 *   slope    — total % change of EMA20 over the last N bars, scaled so a ~15%
 *              rise over the window saturates at 10.
 *   consistency — fraction of the last N closes sitting at/above their EMA20.
 * Steeper + more consistently-above => higher. Downtrends collapse both → ~0.
 */
function trendStrength(bars: Bar[]): number {
  const closes = bars.map((b) => b.c);
  if (closes.length < 2) return SECTOR_PLACEHOLDER; // too short to judge → neutral
  const e = ema(closes, 20);
  const N = Math.min(20, closes.length - 1);
  const last = e[e.length - 1];
  const prev = e[e.length - 1 - N];
  const slopePct = prev > 0 ? (last - prev) / prev : 0; // total % over N bars
  const slopeScore = clamp((slopePct / 0.15) * 10, 0, 10); // 15% over window → 10

  let above = 0;
  for (let i = closes.length - N; i < closes.length; i++) if (closes[i] >= e[i]) above++;
  const consistency = above / N; // 0..1

  return clamp(0.5 * slopeScore + 0.5 * (consistency * 10), 0, 10);
}

/**
 * structure_quality — higher-high / higher-low consistency over the recent
 * window (~20 bars). Detect swing highs and lows, then measure the fraction of
 * each sequence that is rising. Clean uptrend structure (HH + HL) → 10; broken /
 * descending → 0. When there are too few interior pivots to judge (e.g. a strictly
 * monotonic line), fall back to a half-vs-half direction proxy (weak signal).
 */
function structureQuality(bars: Bar[]): number {
  const M = Math.min(20, bars.length);
  const recent = bars.slice(bars.length - M);
  if (recent.length < 3) return SECTOR_PLACEHOLDER; // can't judge → neutral

  const highs = swingValues(recent.map((b) => b.h), 1, 'high');
  const lows = swingValues(recent.map((b) => b.l), 1, 'low');

  const parts: number[] = [];
  if (highs.length >= 2) parts.push(fractionIncreasing(highs));
  if (lows.length >= 2) parts.push(fractionIncreasing(lows));

  if (parts.length === 0) {
    // Too few pivots (monotonic series): half-vs-half close direction proxy.
    const mid = Math.floor(recent.length / 2);
    const firstAvg = mean(recent.slice(0, mid).map((b) => b.c));
    const secondAvg = mean(recent.slice(mid).map((b) => b.c));
    return secondAvg > firstAvg ? 7 : 3;
  }
  return clamp(mean(parts) * 10, 0, 10);
}

/**
 * pullback_quality — THE CORE of a trend-pullback setup. Are we pulling back into
 * support in an orderly way, rather than extended or breaking down?
 *
 * Measure the retracement of the current close off the recent high, as a fraction
 * of the prior leg (recent high − recent low):
 *   retr = (recentHigh − close) / (recentHigh − recentLow)
 *
 * IDEAL BAND: retraced 0.30–0.60 of the prior leg AND still above the 20EMA →
 * full 10. Shallow/none (retr→0, price extended at highs) ramps down toward ~3
 * (nothing to buy, chase risk). Deep (retr→1.0, gave back the whole leg) ramps
 * down toward ~1 (structure failing). And if the close is BELOW the 20EMA at all
 * (pullback isn't holding above a rising MA) the whole score is multiplied by 0.4
 * — a broken-down pullback is not a setup.
 */
function pullbackQuality(bars: Bar[]): number {
  const M = Math.min(20, bars.length);
  const recent = bars.slice(bars.length - M);
  if (recent.length < 3) return SECTOR_PLACEHOLDER; // can't judge → neutral

  const highVals = recent.map((b) => b.h);
  const lowVals = recent.map((b) => b.l);
  const recentHigh = Math.max(...highVals);
  const recentLow = Math.min(...lowVals);
  const close = recent[recent.length - 1].c;

  const leg = recentHigh - recentLow;
  let depthScore: number;
  if (leg <= 0) {
    depthScore = SECTOR_PLACEHOLDER; // degenerate flat series → neutral
  } else {
    const retr = clamp((recentHigh - close) / leg, 0, 1.2);
    if (retr >= 0.3 && retr <= 0.6) {
      depthScore = 10; // ideal orderly pullback
    } else if (retr < 0.3) {
      depthScore = 3 + (retr / 0.3) * 7; // 3 (extended, no pullback) → 10 at 0.3
    } else if (retr <= 1.0) {
      depthScore = 10 - ((retr - 0.6) / 0.4) * 8; // 10 → 2 at full retrace
    } else {
      depthScore = 1; // gave back more than the whole leg → broken
    }
  }

  // Holds above a rising MA? Below the 20EMA = pullback isn't holding → penalise.
  const e = ema(
    bars.map((b) => b.c),
    20,
  );
  const ema20 = e[e.length - 1];
  const aboveFactor = close >= ema20 ? 1 : 0.4;

  return clamp(depthScore * aboveFactor, 0, 10);
}

/**
 * liquidity — average daily DOLLAR volume (close · volume) over the recent window
 * (~20 bars), log-mapped: $1M/day → 0, $1B/day → 10. These are megacaps, so most
 * names saturate near 10; thin names score low. If NO bars carry volume we can't
 * assess it → neutral 5 (flagged in notes), so missing volume never silently
 * blocks a trade.
 */
function liquidity(bars: Bar[]): { score: number; hadVolume: boolean } {
  const M = Math.min(20, bars.length);
  const recent = bars.slice(bars.length - M);
  const withVol = recent.filter((b) => typeof b.v === 'number' && Number.isFinite(b.v));
  if (withVol.length === 0) return { score: MARKET_PLACEHOLDER, hadVolume: false };

  const avgDollar = mean(withVol.map((b) => b.c * (b.v as number)));
  if (avgDollar <= 0) return { score: 0, hadVolume: true };
  // log10($1M)=6 → 0 ; log10($1B)=9 → 10
  const score = clamp(((Math.log10(avgDollar) - 6) / (9 - 6)) * 10, 0, 10);
  return { score, hadVolume: true };
}

// ----------------------------------------------------------------------------
// Public entry point.
// ----------------------------------------------------------------------------

/**
 * Score a setup 1–10 from daily bars (oldest-first, >= ~50 ideally — degrades
 * gracefully and never NaNs on short/degenerate input). PURE.
 */
export function scoreQuality(bars: Bar[], opts: ScoreOptions = {}): QualityBreakdown {
  // Degenerate guard: no usable data → everything neutral, never NaN.
  if (!Array.isArray(bars) || bars.length === 0) {
    return {
      trend_strength: SECTOR_PLACEHOLDER,
      structure_quality: SECTOR_PLACEHOLDER,
      pullback_quality: SECTOR_PLACEHOLDER,
      liquidity: MARKET_PLACEHOLDER,
      sector_strength: SECTOR_PLACEHOLDER,
      market_alignment: MARKET_PLACEHOLDER,
      score: 5, // mean of four neutral real components
      notes:
        'Quality 5/10: no bars — the four real components default to neutral. ' +
        'sector/market pending — not yet in score.',
    };
  }

  const trend = clamp(trendStrength(bars), 0, 10);
  const structure = clamp(structureQuality(bars), 0, 10);
  const pullback = clamp(pullbackQuality(bars), 0, 10);
  const liq = liquidity(bars);
  const liquidityScore = clamp(liq.score, 0, 10);

  // DEFAULT: score the FOUR real components (true 0–10 range). The two pending
  // placeholders are reported but excluded. Flip to 'six' (or pass
  // includePendingPlaceholders) only once sector/market are real — see
  // SCORE_COMPONENT_MODE.
  const real = [trend, structure, pullback, liquidityScore];
  const useSix = opts.includePendingPlaceholders ?? SCORE_COMPONENT_MODE === 'six';
  const basis = useSix ? [...real, SECTOR_PLACEHOLDER, MARKET_PLACEHOLDER] : real;
  const score = clamp(Math.round(mean(basis)), 1, 10);

  const r = (n: number): number => Math.round(n);
  const liqNote = liq.hadVolume ? `${r(liquidityScore)}` : `${r(liquidityScore)} (no vol→neutral)`;
  const scopeNote = useSix
    ? 'mean of all six (sector/market now in score)'
    : 'mean of the four real components; sector/market pending — not yet in score';

  const notes =
    `Quality ${score}/10 (trend ${r(trend)}, structure ${r(structure)}, ` +
    `pullback ${r(pullback)}, liquidity ${liqNote}; sector/market pending). ` +
    `sector_strength & market_alignment are PENDING placeholders (need sector-ETF ` +
    `+ SPY regime data); scored as ${scopeNote}.`;

  return {
    trend_strength: trend,
    structure_quality: structure,
    pullback_quality: pullback,
    liquidity: liquidityScore,
    sector_strength: SECTOR_PLACEHOLDER,
    market_alignment: MARKET_PLACEHOLDER,
    score,
    notes,
  };
}
