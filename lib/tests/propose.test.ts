import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O edges; keep buildProposal + validateProposalRisk + FixtureFeed real.
const { saveProposalMock, mintNonceMock, sendMessageMock, sendProposalCardMock } = vi.hoisted(() => ({
  saveProposalMock: vi.fn(),
  mintNonceMock: vi.fn(),
  sendMessageMock: vi.fn(),
  sendProposalCardMock: vi.fn(),
}));
vi.mock('../persist', () => ({ saveProposal: saveProposalMock, saveDecision: vi.fn() }));
vi.mock('../nonce', () => ({ mintNonce: mintNonceMock }));
vi.mock('../telegram', () => ({
  sendMessage: sendMessageMock,
  sendProposalCard: sendProposalCardMock,
}));

import { runProposal, type RunProposalArgs } from '../propose';
import { FixtureFeed } from '../feeds/fixture';
import type { BuildProposalInput, RegimeInput } from '../build-proposal';
import type { PortfolioContext } from '../proposal';
import type { CostModel } from '../proposal';
import type { Quote } from '../feed';

const COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
};

const QUOTE: Quote = { symbol: 'AAPL', price: 100, asOf: 1_700_000_000_000, prevClose: 99.5 };

function trendingRegime(): RegimeInput {
  return { regime: 'trending_up', adx_14: 31.2, atr_ratio: 1.05, price_above_ema20: true, regime_date: '2026-06-22' };
}

function clearCtx(): PortfolioContext {
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

function buildPieces(over: Partial<Omit<BuildProposalInput, 'symbol' | 'quote'>> = {}): Omit<BuildProposalInput, 'symbol' | 'quote'> {
  return {
    proposal_id: 'p_propose_0001',
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
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
    current_drawdown_pct: 0,
    expected_hold_days: 5,
    costs: COSTS,
    ai_thesis: 'Pullback to rising 20EMA.',
    ...over,
  };
}

function args(over: Partial<RunProposalArgs> = {}): RunProposalArgs {
  return {
    symbol: 'AAPL',
    chatId: '555',
    telegram_user_id: '42',
    feed: new FixtureFeed('us_equity', {}, { AAPL: QUOTE }),
    build: buildPieces(),
    ctx: clearCtx(),
    ...over,
  };
}

beforeEach(() => {
  saveProposalMock.mockReset().mockResolvedValue(undefined);
  mintNonceMock.mockReset().mockImplementation(async (a: { action: string }) => `nonce_${a.action}`);
  sendMessageMock.mockReset().mockResolvedValue(undefined);
  sendProposalCardMock.mockReset().mockResolvedValue({ message_id: 99 });
});

describe('runProposal — passing card', () => {
  it('persists, mints 3 nonces, sends a card with buttons, sent:true', async () => {
    const res = await runProposal(args());

    expect(res).toEqual({ proposal_id: 'p_propose_0001', gate_passed: true, sent: true });
    expect(saveProposalMock).toHaveBeenCalledTimes(1);
    // gate result handed to saveProposal must be passed
    expect(saveProposalMock.mock.calls[0][1].passed).toBe(true);

    // one nonce per action, all bound to user + card expiry
    expect(mintNonceMock).toHaveBeenCalledTimes(3);
    const mintedActions = mintNonceMock.mock.calls.map((c) => c[0].action).sort();
    expect(mintedActions).toEqual(['approve', 'skip', 'snooze']);
    for (const call of mintNonceMock.mock.calls) {
      expect(call[0].telegram_user_id).toBe('42');
      expect(call[0].proposal_id).toBe('p_propose_0001');
      expect(typeof call[0].expires_at).toBe('number');
    }

    expect(sendProposalCardMock).toHaveBeenCalledTimes(1);
    const [chatId, , nonces] = sendProposalCardMock.mock.calls[0];
    expect(chatId).toBe('555');
    expect(nonces).toEqual({ approve: 'nonce_approve', skip: 'nonce_skip', snooze: 'nonce_snooze' });

    // a passing card never goes out as a plain message
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('runProposal — failing card', () => {
  it('persists, mints NO nonces, sends a plain reasons message, sent:false', async () => {
    const res = await runProposal(args({ build: buildPieces({ quality_score: 3 }) }));

    expect(res).toEqual({ proposal_id: 'p_propose_0001', gate_passed: false, sent: false });
    expect(saveProposalMock).toHaveBeenCalledTimes(1);
    expect(saveProposalMock.mock.calls[0][1].passed).toBe(false);

    // discipline: a blocked card gets NO buttons and NO nonces
    expect(mintNonceMock).not.toHaveBeenCalled();
    expect(sendProposalCardMock).not.toHaveBeenCalled();

    // a plain reasons message is sent instead
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessageMock.mock.calls[0];
    expect(chatId).toBe('555');
    expect(text).toContain('blocked');
    expect(text).toContain('quality_below_min');
  });

  it('throws if persistence fails (fail-closed)', async () => {
    saveProposalMock.mockRejectedValue(new Error('db down'));
    await expect(runProposal(args())).rejects.toThrow('db down');
  });
});
