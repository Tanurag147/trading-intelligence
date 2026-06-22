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
import { buildProposal, type BuildProposalInput } from './build-proposal';
import { validateProposalRisk } from './risk-gate';
import { saveProposal } from './persist';
import { mintNonce, verifyAndBurnNonce, type NonceCheck } from './nonce';
import { sendMessage, sendProposalCard, type ProposalAction } from './telegram';
import { FixtureFeed } from './feeds/fixture';
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

  // 4. failed card → plain reasons message, NO buttons.
  if (!gate.passed) {
    const reasons = gate.blocks.map((b) => `• ${b.code}: ${b.detail}`).join('\n');
    await sendMessage(
      args.chatId,
      `🚫 *Proposal blocked — ${card.symbol}*\n\n${reasons}`,
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
