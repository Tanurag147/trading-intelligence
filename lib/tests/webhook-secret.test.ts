import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock every @/lib edge the route pulls in, so importing the route never touches
// the network or the real supabase client. decide() is left REAL so the callback
// tests exercise the genuine reducer (thesis/reason defaults, outcomes).
const {
  sendMessageMock,
  answerCallbackQueryMock,
  editMessageTextMock,
  formatProposalCardMock,
  resolveAndBurnMock,
  loadProposalMock,
  saveDecisionMock,
} = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  answerCallbackQueryMock: vi.fn(),
  editMessageTextMock: vi.fn(),
  formatProposalCardMock: vi.fn(() => 'CARD'),
  resolveAndBurnMock: vi.fn(),
  loadProposalMock: vi.fn(),
  saveDecisionMock: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/telegram', () => ({
  sendMessage: sendMessageMock,
  regimeEmoji: () => '',
  answerCallbackQuery: answerCallbackQueryMock,
  editMessageText: editMessageTextMock,
  formatProposalCard: formatProposalCardMock,
}));
vi.mock('@/lib/trading', () => ({
  calculatePositionSize: () => ({ units: 0, riskAmount: 0, riskPct: 0 }),
  calculateRRRatio: () => 0,
  minimumTarget: () => 0,
}));
vi.mock('@/lib/propose', () => ({
  resolveAndBurnCallback: resolveAndBurnMock,
  loadProposalForCallback: loadProposalMock,
}));
vi.mock('@/lib/persist', () => ({ saveDecision: saveDecisionMock }));

import { POST } from '@/app/api/telegram/route';
import { buildProposal } from '@/lib/build-proposal';
import { DEFAULT_LIMITS, type RiskGateResult, type ProposalCard } from '@/lib/proposal';
import type { CostModel } from '@/lib/proposal';

const SECRET = 'topsecret-token-value';

function req(body: unknown, secretHeader?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secretHeader !== undefined) headers['x-telegram-bot-api-secret-token'] = secretHeader;
  return new Request('http://localhost/api/telegram', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function cbReq(data: string, opts: { userId?: number; withMessage?: boolean } = {}): Request {
  const message = opts.withMessage === false ? undefined : { chat: { id: 555 }, message_id: 7 };
  return req({ callback_query: { id: 'cb1', from: { id: opts.userId ?? 42 }, message, data } });
}

const COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
};

function freshCard(): ProposalCard {
  // created_at = now => expires_at ~15min ahead, so decide() won't reject on expiry.
  return buildProposal({
    proposal_id: 'p1',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
    quote: { symbol: 'AAPL', price: 100, asOf: Date.now(), prevClose: 99.5 },
    entry_price: 100,
    stop_price: 98,
    target_price: 105,
    regime: { regime: 'trending_up', adx_14: 31, atr_ratio: 1.05, price_above_ema20: true, regime_date: '2026-06-22' },
    quality_score: 8,
    setup_sample_size: 12,
    strategy_health: 'green',
    capital: 2500,
    risk_pct: 0.005,
    currency: 'USD',
    correlation_cluster: 'megacap_tech',
    cluster_risk_pct_after: 0.005,
    current_drawdown_pct: 0,
    expected_hold_days: 5,
    costs: COSTS,
    ai_thesis: 'Pullback to rising 20EMA.',
  });
}

function passingGate(): RiskGateResult {
  return { passed: true, blocks: [], applied_limits: DEFAULT_LIMITS, evaluated_at: Date.now() };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(undefined);
  answerCallbackQueryMock.mockReset().mockResolvedValue(undefined);
  editMessageTextMock.mockReset().mockResolvedValue(undefined);
  resolveAndBurnMock.mockReset();
  loadProposalMock.mockReset();
  saveDecisionMock.mockReset().mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

describe('webhook secret guard', () => {
  it('rejects a missing secret header with 401 and logs the rejection', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const res = await POST(req({ message: { chat: { id: 1 }, text: 'trading:help' } }));

    expect(res.status).toBe(401);
    expect(errorSpy).toHaveBeenCalledWith('rejected webhook: bad secret token');
    expect(errorSpy).toHaveBeenCalledWith('rejected callback', expect.stringContaining('bad_secret_token'));
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('rejects an incorrect secret header with 401', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const res = await POST(req({ message: { chat: { id: 1 }, text: 'trading:help' } }, 'wrong'));
    expect(res.status).toBe(401);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('proceeds to normal handling when the secret matches', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    const res = await POST(req({ message: { chat: { id: 1 }, text: 'trading:help' } }, SECRET));
    expect(res.status).toBe(200);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith('1', expect.stringContaining('Trading Intelligence'));
  });

  it('allows the request (with a warning) when the secret env var is unset', async () => {
    const res = await POST(req({ message: { chat: { id: 1 }, text: 'trading:help' } }));
    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe('button callback handler', () => {
  it('approve: verifies+burns, decides, saves with founder_thesis, acks + locks card', async () => {
    resolveAndBurnMock.mockResolvedValue({ ok: true, proposal_id: 'p1', action: 'approve' });
    loadProposalMock.mockResolvedValue({ card: freshCard(), gate: passingGate() });

    const res = await POST(cbReq('v3:approve:p1'));

    expect(res.status).toBe(200);
    expect(resolveAndBurnMock).toHaveBeenCalledWith({ proposal_id: 'p1', action: 'approve', telegram_user_id: '42' });
    expect(saveDecisionMock).toHaveBeenCalledTimes(1);
    const rec = saveDecisionMock.mock.calls[0][0];
    expect(rec.outcome).toBe('approved');
    expect(rec.accepted).toBe(true);
    expect(rec.founder_thesis).toBe('approved_via_button');
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', '✅ Approved');
    expect(editMessageTextMock).toHaveBeenCalledTimes(1);
    const [chatId, messageId] = editMessageTextMock.mock.calls[0];
    expect(chatId).toBe('555');
    expect(messageId).toBe(7);
  });

  it('skip: stores reason_code personal_override and acks Skipped', async () => {
    resolveAndBurnMock.mockResolvedValue({ ok: true, proposal_id: 'p1', action: 'skip' });
    loadProposalMock.mockResolvedValue({ card: freshCard(), gate: passingGate() });

    const res = await POST(cbReq('v3:skip:p1'));

    expect(res.status).toBe(200);
    const rec = saveDecisionMock.mock.calls[0][0];
    expect(rec.outcome).toBe('skipped');
    expect(rec.reason_code).toBe('personal_override');
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', '⏭ Skipped');
  });

  it('snooze: stores a resnooze_until and acks Snoozed 15m', async () => {
    resolveAndBurnMock.mockResolvedValue({ ok: true, proposal_id: 'p1', action: 'snooze' });
    loadProposalMock.mockResolvedValue({ card: freshCard(), gate: passingGate() });

    const res = await POST(cbReq('v3:snooze:p1'));
    expect(res.status).toBe(200);
    const rec = saveDecisionMock.mock.calls[0][0];
    expect(rec.outcome).toBe('snoozed');
    expect(rec.resnooze_until).toBeTypeOf('number');
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', '⏱ Snoozed 15m');
  });

  it('expired nonce: no decision saved, acks Expired, voids the card, logs', async () => {
    resolveAndBurnMock.mockResolvedValue({ ok: false, reason: 'expired' });

    const res = await POST(cbReq('v3:approve:p1'));

    expect(res.status).toBe(200);
    expect(saveDecisionMock).not.toHaveBeenCalled();
    expect(loadProposalMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', 'Expired');
    expect(editMessageTextMock).toHaveBeenCalledTimes(1); // voided
    expect(errorSpy).toHaveBeenCalledWith('rejected callback', expect.stringContaining('expired'));
  });

  it('already-used nonce: no decision, acks Already actioned, voids the card', async () => {
    resolveAndBurnMock.mockResolvedValue({ ok: false, reason: 'already_used' });

    const res = await POST(cbReq('v3:skip:p1'));
    expect(res.status).toBe(200);
    expect(saveDecisionMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', 'Already actioned');
    expect(editMessageTextMock).toHaveBeenCalledTimes(1);
  });

  it('wrong user (user_mismatch): no decision, acks Not allowed, does NOT void card', async () => {
    resolveAndBurnMock.mockResolvedValue({ ok: false, reason: 'user_mismatch' });

    const res = await POST(cbReq('v3:approve:p1', { userId: 999 }));
    expect(res.status).toBe(200);
    expect(saveDecisionMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', 'Not allowed');
    expect(editMessageTextMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith('rejected callback', expect.stringContaining('user_mismatch'));
  });

  it('malformed callback_data: acks Invalid, never resolves a nonce, returns 200', async () => {
    const res = await POST(cbReq('garbage'));
    expect(res.status).toBe(200);
    expect(resolveAndBurnMock).not.toHaveBeenCalled();
    expect(saveDecisionMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', 'Invalid');
    expect(errorSpy).toHaveBeenCalledWith('rejected callback', expect.stringContaining('malformed_callback_data'));
  });

  it('unknown proposal (load returns null): acks Not found, no decision saved', async () => {
    resolveAndBurnMock.mockResolvedValue({ ok: true, proposal_id: 'p1', action: 'approve' });
    loadProposalMock.mockResolvedValue(null);

    const res = await POST(cbReq('v3:approve:p1'));
    expect(res.status).toBe(200);
    expect(saveDecisionMock).not.toHaveBeenCalled();
    expect(answerCallbackQueryMock).toHaveBeenCalledWith('cb1', 'Not found');
  });
});
