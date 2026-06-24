/**
 * lib/propose.ts — The propose pipeline + callback resolution for Trading OS v3.
 *
 * Two responsibilities, both wiring (no new business rules):
 *
 *  1. runProposal: build → gate → persist → notify. EVERY proposal is persisted
 *     (passed or not). A card that FAILS the gate is sent as a plain reasons
 *     message with NO buttons — a blocked trade is never approvable, so the UI
 *     never offers an approve button for it (discipline enforced at the surface).
 *     Only a PASSED card mints 3 single-use nonces and ships with buttons.
 *
 *  2. Callback resolution helpers used by the webhook:
 *     - resolveAndBurnCallback: translate (proposal_id, action) → nonce, then
 *       delegate to verifyAndBurnNonce (the single-use lock lives there).
 *     - loadProposalForCallback: rehydrate the ProposalCard + a RiskGateResult
 *       from trading_proposals so decide() can run at tap time.
 *
 * callback_data design: `v3:<action>:<proposal_id>`. The 64-hex nonce is too
 * long for Telegram's 64-byte callback_data cap, so the button carries the short
 * proposal_id and the nonce is found server-side by (proposal_id, action). There
 * is exactly one nonce per (proposal_id, action), so that lookup is unique.
 *
 * Live-portfolio ctx at callback time: NOT available here yet. We do NOT re-run
 * the full risk gate against fresh portfolio state on a tap; we trust the gate
 * result stored at send time (gate_passed/gate_blocks on trading_proposals).
 * Justification + bounded risk: nonces only exist for cards that passed, and
 * expire with the card (~15 min), so the staleness window is small; and the
 * system is an intelligence layer — the founder still places the real order by
 * hand. RISK: portfolio state (open risk, drawdown, weekly cap) may have changed
 * since send, so a button-approve isn't re-checked against it. Later enhancement:
 * fetch live PortfolioContext and re-validate at tap time.
 */

import { supabase } from './supabase';
import { buildProposal, type BuildProposalInput, type RegimeInput } from './build-proposal';
import { calculateRegime } from './regime';
import { validateProposalRisk } from './risk-gate';
import { saveProposal } from './persist';
import { mintNonce, verifyAndBurnNonce, type NonceCheck } from './nonce';
import { sendMessage, sendProposalCard, escapeHtml, type ProposalAction } from './telegram';
import { FixtureFeed } from './feeds/fixture';
import { scoreQuality } from './quality';
import {
  DEFAULT_LIMITS,
  type ProposalCard,
  type RiskGateResult,
  type PortfolioContext,
  type RiskLimits,
  type CostModel,
} from './proposal';
import type { MarketFeed, Quote, Bar } from './feed';

const NONCE_TABLE = 'trading_callback_nonces';

export interface RunProposalArgs {
  symbol: string;
  chatId: string;
  telegram_user_id: string;
  feed: MarketFeed;
  /** Everything buildProposal needs except symbol + quote (supplied here). */
  build: Omit<BuildProposalInput, 'symbol' | 'quote'>;
  /** Live portfolio context for the gate (caller supplies). */
  ctx: PortfolioContext;
  limits?: Partial<RiskLimits>;
}

export interface RunProposalResult {
  proposal_id: string;
  gate_passed: boolean;
  sent: boolean;
}

export async function runProposal(args: RunProposalArgs): Promise<RunProposalResult> {
  // 1. build the card (fetch a fresh quote off the injected feed first).
  const quote = await args.feed.getQuote(args.symbol);
  const card = buildProposal({ ...args.build, symbol: args.symbol, quote });

  // 2. gate.
  const gate = validateProposalRisk({ card, ctx: args.ctx, limits: args.limits });

  // 3. persist EVERY proposal, passed or not.
  await saveProposal(card, gate);

  // 4. failed card → plain reasons message, NO buttons. Rendered in HTML parse
  //    mode (same path the card uses): block codes carry underscores
  //    (net_expectancy_below_min, risk_per_trade_exceeded, cluster_risk_exceeded)
  //    and details carry <, >, &, % — all of which open stray entities under
  //    Markdown and 400 the send, leaving the founder with silence instead of
  //    the rejection reasons. escapeHtml() both code and detail; HTML treats only
  //    &/</> as special, so underscores render literally.
  if (!gate.passed) {
    const reasons = gate.blocks
      .map((b) => `• ${escapeHtml(b.code)}: ${escapeHtml(b.detail)}`)
      .join('\n');
    await sendMessage(
      args.chatId,
      `🚫 <b>Proposal blocked — ${escapeHtml(card.symbol)}</b>\n\n${reasons}`,
      'HTML',
    );
    return { proposal_id: card.proposal_id, gate_passed: false, sent: false };
  }

  // 5. passed card → mint 3 single-use nonces, then send with buttons.
  const actions: ProposalAction[] = ['approve', 'skip', 'snooze'];
  const [approve, skip, snooze] = await Promise.all(
    actions.map((action) =>
      mintNonce({
        proposal_id: card.proposal_id,
        action,
        telegram_user_id: args.telegram_user_id,
        expires_at: card.expires_at,
      }),
    ),
  );

  await sendProposalCard(args.chatId, card, { approve, skip, snooze });
  return { proposal_id: card.proposal_id, gate_passed: true, sent: true };
}

// ----------------------------------------------------------------------------
// Fixture assembler — the paper-phase stand-in that turns a bare symbol into the
// full RunProposalArgs runProposal needs. Until the live quality/regime/portfolio
// reads are wired, `trading:propose SYMBOL` uses this to exercise the whole
// build → gate → persist → card path deterministically. The values are chosen to
// PASS the gate under DEFAULT_LIMITS (tier-4 trending_up, 2.5RR geometry,
// quality 8, risk within every cap), so a propose always demonstrates the happy
// path with live approve/skip/snooze buttons.
// ----------------------------------------------------------------------------

const FIXTURE_COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
};

const CLUSTER_BY_SYMBOL: Record<string, string> = {
  AAPL: 'megacap_tech',
  MSFT: 'megacap_tech',
  META: 'megacap_tech',
  GOOGL: 'megacap_tech',
  AMZN: 'megacap_tech',
  NVDA: 'ai_cluster',
  AMD: 'ai_cluster',
  TSLA: 'ai_cluster',
  SPY: 'etf_cluster',
  QQQ: 'etf_cluster',
};

/** Correlation cluster for a symbol; unknowns fall back to 'misc'. */
export function correlationClusterFor(symbol: string): string {
  return CLUSTER_BY_SYMBOL[symbol.toUpperCase()] ?? 'misc';
}

/**
 * Deterministic, gate-PASSING RunProposalArgs for `symbol`, fed by an in-memory
 * FixtureFeed (no network). Quote, bars, regime, geometry and portfolio context
 * are all fixed so runProposal builds a card that clears the risk gate every time.
 */
export function buildFixtureProposalInput(
  symbol: string,
  chatId: string,
  telegram_user_id: string,
): RunProposalArgs {
  const sym = symbol.toUpperCase();
  const now = Date.now();
  const regime_date = new Date(now).toISOString().slice(0, 10);

  const quote: Quote = { symbol: sym, price: 100, asOf: now, prevClose: 100 };

  // Seed bars + quote so any getBars/getQuote runProposal makes resolves.
  const bar: Bar = { t: now, o: 99, h: 101, l: 98, c: 100 };
  const feed = new FixtureFeed(
    'us_equity',
    { [sym]: [bar, bar, bar] },
    { [sym]: quote },
  );

  const build: Omit<BuildProposalInput, 'symbol' | 'quote'> = {
    proposal_id: `prop_${sym}_${now}`,
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
    entry_price: 100,
    stop_price: 98,
    target_price: 105,
    regime: {
      regime: 'trending_up',
      adx_14: 31,
      atr_ratio: 1.05,
      price_above_ema20: true,
      regime_date,
    },
    quality_score: 8,
    setup_sample_size: 12,
    strategy_health: 'green',
    capital: 2500,
    risk_pct: 0.005,
    currency: 'USD',
    correlation_cluster: correlationClusterFor(sym),
    cluster_risk_pct_after: 0.005,
    current_drawdown_pct: 0,
    expected_hold_days: 5,
    costs: FIXTURE_COSTS,
    ai_thesis: 'Fixture: pullback to a rising 20EMA inside an established uptrend.',
  };

  const ctx: PortfolioContext = {
    total_open_risk_pct: 0.005,
    cluster_risk_pct: 0,
    trades_this_week: 0,
    consecutive_losses: 0,
    current_drawdown_pct: 0,
    strategy_health: 'green',
    data_integrity_ok: true,
    in_macro_blackout: false,
    earnings_in_window: false,
  };

  return { symbol: sym, chatId, telegram_user_id, feed, build, ctx };
}

// ----------------------------------------------------------------------------
// REAL-DATA wiring (Trading OS v3). The fixture above is the deterministic
// stand-in; the helpers below turn a live MarketFeed (AlpacaFeed) into the same
// RunProposalArgs shape using REAL bars, REAL regime (reusing regime.ts — not a
// reimplementation), and REAL ATR-based geometry. No new indicator math: regime
// labelling stays in calculateRegime; we only compute the ATR the stop needs
// (regime.ts doesn't expose it) with the SAME Wilder method it uses internally.
// ----------------------------------------------------------------------------

/** Bar[] -> the [ts,o,h,l,c] tuple shape calculateRegime aggregates/consumes. */
function barsToOhlcTuples(bars: Bar[]): [number, number, number, number, number][] {
  return bars.map((b) => [b.t, b.o, b.h, b.l, b.c]);
}

/**
 * Run real bars through the regime engine and return the decoupled RegimeInput
 * the proposal pipeline consumes (toRegimeView -> mapRegimeToTier). Pure given
 * bars — calculateRegime owns all indicator math; we only reshape its result.
 */
export function regimeInputFromBars(symbol: string, bars: Bar[]): RegimeInput {
  const r = calculateRegime(symbol, barsToOhlcTuples(bars));
  return {
    regime: r.regime,
    adx_14: r.adx_14,
    atr_ratio: r.atr_ratio,
    price_above_ema20: r.price_above_ema20,
    regime_date: r.regime_date,
  };
}

/**
 * Fetch daily bars off the feed and derive a real RegimeInput. lookback 60 ≫ the
 * 28-candle minimum regime.ts enforces (AlpacaFeed over-fetches by date, so this
 * survives holidays/weekends). A real 'trending_up' -> tier 4 (eligible);
 * anything else -> a blocked tier. No new regime logic.
 */
export async function buildRegimeFromBars(symbol: string, feed: MarketFeed): Promise<RegimeInput> {
  const bars = await feed.getBars(symbol, '1d', 60);
  return regimeInputFromBars(symbol, bars);
}

/**
 * Wilder ATR(14) from daily bars — the SAME true-range + Wilder smoothing
 * regime.ts uses internally (it just doesn't expose the value). Bars are sorted
 * ascending defensively. Throws if there aren't enough bars to seed the average.
 */
export function atr14FromBars(bars: Bar[]): number {
  const period = 14;
  const ordered = [...bars].sort((a, b) => a.t - b.t);
  if (ordered.length < period + 1) {
    throw new Error(`atr14FromBars: need >= ${period + 1} bars, got ${ordered.length}`);
  }
  const tr: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i];
    const prev = ordered[i - 1];
    tr.push(
      Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)),
    );
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr = atr / period; // Wilder seed = simple average of the first `period` TRs
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/** Round UP to whole cents, collapsing float noise first so an already-exact
 *  cent value isn't bumped a spurious extra cent. */
function ceilToCents(x: number): number {
  return Math.ceil(Number((x * 100).toFixed(6))) / 100;
}

/**
 * ATR-based long geometry (validation phase, long-only): risk a fixed 1.5×ATR,
 * target a clean 2R. Prices round to 2dp (equity prices).
 *
 * The gate independently re-derives R:R from these prices and rejects anything
 * below min_rr — so the 2R intent MUST survive rounding. Rounding stop and target
 * independently to 2dp can shorten the reward and push realised R:R measurably
 * below 2.0 (observed down to ~1.9935R), which is a false-negative block. To
 * prevent that we derive the target from the POST-ROUNDING risk and round the
 * target UP to cents, so realised R:R is always >= 2.0 (only float-division
 * residual remains, which the gate's RR_EPSILON absorbs).
 */
export function computeGeometry(entry: number, atr14: number): { stop: number; target: number } {
  const risk_per_unit = 1.5 * atr14;
  const stop = Number((entry - risk_per_unit).toFixed(2));
  const rounded_risk = entry - stop; // the risk the gate will actually see
  const target = ceilToCents(entry + 2.0 * rounded_risk);
  return { stop, target };
}

/** Post-entry forward bars for a shadow phantom: only bars STRICTLY after the
 *  proposal's created_at. Too-recent proposals yield too few bars and the shadow
 *  correctly stays 'open' until more accrue. Pure + exported so it's unit-tested. */
export function postEntryBars(bars: Bar[], createdAt: number): Bar[] {
  return bars.filter((b) => b.t > createdAt);
}

/**
 * REAL RunProposalArgs for `symbol`, fed by a live MarketFeed (AlpacaFeed). Real
 * entry (latest trade price), real regime, real ATR stop. Fetches daily bars
 * ONCE and reuses them for both regime and ATR (no double getBars).
 *
 * PLACEHOLDERS still in place (flagged for later steps):
 *  - quality_score: fixed 8 — real quality scoring is a later step, NOT faked here.
 *  - ctx: a clean passing PortfolioContext — real portfolio-state wiring (open
 *    risk, drawdown, weekly cadence, blackout/earnings) is a later step.
 *  - setup/setup_sample_size/strategy_health: fixed — setup classification + live
 *    stats are later steps too.
 */
export async function buildRealProposalInput(
  symbol: string,
  chatId: string,
  telegram_user_id: string,
  feed: MarketFeed,
): Promise<RunProposalArgs> {
  const sym = symbol.toUpperCase();

  // Fetch bars ONCE; derive both regime and ATR from the same series.
  const bars = await feed.getBars(sym, '1d', 60);
  const regimeInput = regimeInputFromBars(sym, bars);
  const atr = atr14FromBars(bars);

  // Entry = latest TRADE price (AlpacaFeed.getQuote guards zero/missing; we
  // double-check fail-closed because a 0 entry corrupts sizing + R math).
  const quote = await feed.getQuote(sym);
  const entry = quote.price;
  if (!(typeof entry === 'number' && Number.isFinite(entry) && entry > 0)) {
    throw new Error(`buildRealProposalInput: no valid entry price for ${sym}`);
  }

  const { stop, target } = computeGeometry(entry, atr);
  const risk_per_unit = 1.5 * atr;

  // REAL quality score from the SAME daily bars already fetched for regime/ATR
  // (no second getBars). The card's quality_score now does real work: the gate's
  // min_quality_score (8) blocks a tier-4 trending name whose pullback is weak or
  // whose structure is broken with `quality_below_min`. See lib/quality.ts for the
  // six-component breakdown + the honest ceiling note (two neutral placeholders
  // cap the realistic max at 8).
  const quality = scoreQuality(bars);

  const build: Omit<BuildProposalInput, 'symbol' | 'quote'> = {
    proposal_id: `prop_${sym}_${Date.now()}`,
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
    entry_price: entry,
    stop_price: stop,
    target_price: target,
    regime: regimeInput,
    quality_score: quality.score, // REAL 1–10 from daily bars (was hardcoded 8).
    setup_sample_size: 12, // PLACEHOLDER — live setup stats not wired yet.
    strategy_health: 'green', // PLACEHOLDER — live strategy-health not wired yet.
    capital: 2500,
    risk_pct: 0.005,
    currency: 'USD',
    correlation_cluster: correlationClusterFor(sym),
    cluster_risk_pct_after: 0.005,
    current_drawdown_pct: 0,
    expected_hold_days: 5,
    costs: FIXTURE_COSTS, // the pessimistic CostModel
    ai_thesis:
      `Long ${sym} in a ${regimeInput.regime} regime ` +
      `(ADX ${regimeInput.adx_14}, ${regimeInput.price_above_ema20 ? 'price>EMA20' : 'price<EMA20'}). ` +
      `Entry ${entry}; ATR(14) ${atr.toFixed(2)} → 1.5×ATR stop ${stop} ` +
      `(${risk_per_unit.toFixed(2)}/unit risk), 2R target ${target}. ` +
      quality.notes,
  };

  // PLACEHOLDER — clean passing context; live portfolio state wiring comes later.
  const ctx: PortfolioContext = {
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

  return { symbol: sym, chatId, telegram_user_id, feed, build, ctx };
}

/**
 * Translate a button tap (proposal_id, action) into a nonce and burn it.
 * The lookup is by (proposal_id, action) only — NOT filtered by user — so that
 * verifyAndBurnNonce can still detect and report a user_mismatch rather than
 * masking it as not_found. The single-use burn happens inside verifyAndBurnNonce.
 */
export async function resolveAndBurnCallback(args: {
  proposal_id: string;
  action: string;
  telegram_user_id: string;
}): Promise<NonceCheck> {
  const { data, error } = await supabase
    .from(NONCE_TABLE)
    .select('nonce')
    .eq('proposal_id', args.proposal_id)
    .eq('action', args.action)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: 'not_found' };

  return verifyAndBurnNonce({
    nonce: data.nonce,
    expected_action: args.action,
    telegram_user_id: args.telegram_user_id,
  });
}

export interface StoredProposal {
  card: ProposalCard;
  gate: RiskGateResult;
}

/**
 * Rehydrate a proposal from trading_proposals for decide() at callback time.
 * The gate is reconstructed from the STORED gate_passed/gate_blocks (see the
 * file header on why we trust the send-time gate rather than re-running it).
 */
export async function loadProposalForCallback(
  proposal_id: string,
): Promise<StoredProposal | null> {
  const { data, error } = await supabase
    .from('trading_proposals')
    .select('card_json, gate_passed, gate_blocks')
    .eq('proposal_id', proposal_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const gate: RiskGateResult = {
    passed: data.gate_passed as boolean,
    blocks: (data.gate_blocks as RiskGateResult['blocks']) ?? [],
    applied_limits: DEFAULT_LIMITS,
    evaluated_at: Date.now(),
  };
  return { card: data.card_json as ProposalCard, gate };
}
