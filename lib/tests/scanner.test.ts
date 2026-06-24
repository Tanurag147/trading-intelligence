import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the I/O edges; keep buildProposal + validateProposalRisk REAL --------
// An in-memory fake of the supabase Proxy backs trading_scan_alerts so canAlert /
// recordAlert exercise their REAL query logic (filters, count, cooldown window)
// against a store we can seed and inspect — no network, fully deterministic.
const { dbFrom, dbStore, dbSeed, buildRealMock, saveProposalMock, mintNonceMock, sendProposalCardMock } =
  vi.hoisted(() => {
    interface Row {
      symbol: string;
      proposal_id: string | null;
      outcome: string;
      alerted_at: string;
      scan_date: string;
    }
    const store: Row[] = [];

    function dbFrom(table: string) {
      const filters: Array<[string, unknown]> = [];
      const gtes: Array<[string, string]> = [];
      let counting = false;
      let toInsert: Row | null = null;

      const run = () => {
        if (toInsert) {
          store.push(toInsert);
          return { data: null, error: null };
        }
        let rows = store.filter(() => table === 'trading_scan_alerts');
        for (const [c, v] of filters) rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[c] === v);
        for (const [c, v] of gtes) rows = rows.filter((r) => String((r as unknown as Record<string, unknown>)[c]) >= v);
        if (counting) return { data: null, count: rows.length, error: null };
        return { data: rows, error: null };
      };

      const q = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.count) counting = true;
          return q;
        },
        insert(row: Row) {
          toInsert = row;
          return q;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return q;
        },
        gte(col: string, val: string) {
          gtes.push([col, val]);
          return q;
        },
        limit(_n: number) {
          return q;
        },
        then(resolve: (v: unknown) => void) {
          return Promise.resolve(run()).then(resolve);
        },
      };
      return q;
    }

    const dbSeed = (row: Partial<Row>) =>
      store.push({
        symbol: 'SEED',
        proposal_id: null,
        outcome: 'sent',
        alerted_at: new Date().toISOString(),
        scan_date: new Date().toISOString().slice(0, 10),
        ...row,
      });

    return {
      dbFrom,
      dbStore: store,
      dbSeed,
      buildRealMock: vi.fn(),
      saveProposalMock: vi.fn(),
      mintNonceMock: vi.fn(),
      sendProposalCardMock: vi.fn(),
    };
  });

vi.mock('../supabase', () => ({ supabase: { from: dbFrom } }));
vi.mock('../propose', () => ({ buildRealProposalInput: buildRealMock }));
vi.mock('../persist', () => ({ saveProposal: saveProposalMock }));
vi.mock('../nonce', () => ({ mintNonce: mintNonceMock }));
vi.mock('../telegram', () => ({ sendProposalCard: sendProposalCardMock }));
vi.mock('../feeds/alpaca', () => ({ AlpacaFeed: class { } }));

import { isMarketHours, canAlert, recordAlert, runScan, WATCHLIST, SCAN_LIMITS } from '../scanner';
import type { BuildProposalInput, RegimeInput } from '../build-proposal';
import type { PortfolioContext, CostModel } from '../proposal';

const COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
};

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

// A gate-PASSING build (mirrors propose.test's passing pieces). quality_score 3
// trips quality_below_min and fails the gate.
function buildPieces(symbol: string, pass: boolean): Omit<BuildProposalInput, 'symbol' | 'quote'> {
  return {
    proposal_id: `prop_${symbol}`,
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
    entry_price: 100,
    stop_price: 98,
    target_price: 105,
    regime: trendingRegime(),
    quality_score: pass ? 8 : 3,
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
  };
}

// What the mocked buildRealProposalInput returns (feed is never used by runScan —
// it synthesises the quote from build.entry_price). `failSymbols` gate-fail.
function wireBuildReal(failSymbols: Set<string> = new Set()) {
  buildRealMock.mockImplementation(
    async (symbol: string, chatId: string, telegram_user_id: string) => ({
      symbol,
      chatId,
      telegram_user_id,
      feed: {},
      build: buildPieces(symbol, !failSymbols.has(symbol)),
      ctx: clearCtx(),
    }),
  );
}

// A weekday mid-session ET instant (EDT, 11:00) and a weekend one.
const OPEN_NOW = new Date('2026-06-24T15:00:00Z'); // Wed 11:00 EDT
const CLOSED_NOW = new Date('2026-06-27T15:00:00Z'); // Sat

beforeEach(() => {
  dbStore.length = 0;
  buildRealMock.mockReset();
  saveProposalMock.mockReset().mockResolvedValue(undefined);
  mintNonceMock.mockReset().mockImplementation(async (a: { action: string }) => `nonce_${a.action}`);
  sendProposalCardMock.mockReset().mockResolvedValue({ message_id: 99 });
});

describe('isMarketHours', () => {
  it('true mid-session on a weekday', () => {
    expect(isMarketHours(OPEN_NOW)).toBe(true);
  });
  it('false on a weekend', () => {
    expect(isMarketHours(CLOSED_NOW)).toBe(false);
  });
  it('false at 03:00 ET', () => {
    expect(isMarketHours(new Date('2026-06-24T07:00:00Z'))).toBe(false); // 03:00 EDT
  });
  it('true at exactly 09:30 ET', () => {
    expect(isMarketHours(new Date('2026-06-24T13:30:00Z'))).toBe(true); // 09:30 EDT
  });
  it('false at 16:01 ET', () => {
    expect(isMarketHours(new Date('2026-06-24T20:01:00Z'))).toBe(false); // 16:01 EDT
  });
  // DST-sensitive: the SAME 13:45 UTC instant is open in summer (09:45 EDT) but
  // closed in winter (08:45 EST). Proves the ET conversion honours DST.
  it('true at 13:45 UTC in summer (09:45 EDT)', () => {
    expect(isMarketHours(new Date('2026-06-24T13:45:00Z'))).toBe(true);
  });
  it('false at 13:45 UTC in winter (08:45 EST)', () => {
    expect(isMarketHours(new Date('2026-01-14T13:45:00Z'))).toBe(false);
  });
});

describe('canAlert', () => {
  it('cooldown blocks within 4h, allows after', async () => {
    const now = new Date('2026-06-24T15:00:00Z');
    // a 'sent' AAPL alert 1h ago -> within the 4h cooldown.
    dbSeed({ symbol: 'AAPL', outcome: 'sent', alerted_at: new Date(now.getTime() - 1 * 3_600_000).toISOString() });
    expect(await canAlert('AAPL', now)).toEqual({ ok: false, reason: 'cooldown' });

    // 5h later the same alert is outside the window -> allowed.
    const later = new Date(now.getTime() + 5 * 3_600_000);
    expect(await canAlert('AAPL', later)).toEqual({ ok: true });
  });

  it('daily_cap blocks at max_alerts_per_day sent today', async () => {
    const now = new Date('2026-06-24T15:00:00Z');
    const today = now.toISOString().slice(0, 10);
    for (let i = 0; i < SCAN_LIMITS.max_alerts_per_day; i++) {
      dbSeed({ symbol: `S${i}`, outcome: 'sent', scan_date: today, alerted_at: now.toISOString() });
    }
    expect(await canAlert('AAPL', now)).toEqual({ ok: false, reason: 'daily_cap' });
  });

  it('does not count non-sent rows toward the cap', async () => {
    const now = new Date('2026-06-24T15:00:00Z');
    const today = now.toISOString().slice(0, 10);
    for (let i = 0; i < 6; i++) {
      dbSeed({ symbol: `S${i}`, outcome: 'blocked', scan_date: today, alerted_at: now.toISOString() });
    }
    expect(await canAlert('AAPL', now)).toEqual({ ok: true });
  });
});

describe('recordAlert', () => {
  it('inserts a row stamped from `now`', async () => {
    const now = new Date('2026-06-24T15:00:00Z');
    await recordAlert('AAPL', 'prop_AAPL', 'sent', now);
    expect(dbStore).toHaveLength(1);
    expect(dbStore[0]).toMatchObject({
      symbol: 'AAPL',
      proposal_id: 'prop_AAPL',
      outcome: 'sent',
      scan_date: '2026-06-24',
    });
  });
});

describe('runScan', () => {
  it('market closed -> scanned 0, nothing sent, pipeline never touched', async () => {
    wireBuildReal();
    const res = await runScan({ chatId: '555', telegram_user_id: '42', now: CLOSED_NOW, sleepMs: 0 });
    expect(res.scanned).toBe(0);
    expect(res.sent).toBe(0);
    expect(buildRealMock).not.toHaveBeenCalled();
    expect(sendProposalCardMock).not.toHaveBeenCalled();
  });

  it('a passing symbol -> card sent with buttons, recordAlert sent', async () => {
    // Only AAPL passes; the rest gate-fail so we isolate one send.
    const fails = new Set(WATCHLIST.filter((s) => s !== 'AAPL'));
    wireBuildReal(fails);

    const res = await runScan({ chatId: '555', telegram_user_id: '42', now: OPEN_NOW, sleepMs: 0 });

    expect(res.scanned).toBe(WATCHLIST.length);
    expect(res.sent).toBe(1);
    expect(sendProposalCardMock).toHaveBeenCalledTimes(1);
    const [chatId, card, nonces] = sendProposalCardMock.mock.calls[0];
    expect(chatId).toBe('555');
    expect(card.symbol).toBe('AAPL');
    expect(nonces).toEqual({ approve: 'nonce_approve', skip: 'nonce_skip', snooze: 'nonce_snooze' });

    // a 'sent' row was recorded for AAPL
    const sentRows = dbStore.filter((r) => r.outcome === 'sent');
    expect(sentRows.map((r) => r.symbol)).toEqual(['AAPL']);
  });

  it('a failing-gate symbol -> NO send, recordAlert blocked (silent)', async () => {
    wireBuildReal(new Set(WATCHLIST)); // everything fails the gate
    const res = await runScan({ chatId: '555', telegram_user_id: '42', now: OPEN_NOW, sleepMs: 0 });

    expect(res.sent).toBe(0);
    expect(sendProposalCardMock).not.toHaveBeenCalled();
    expect(mintNonceMock).not.toHaveBeenCalled();
    // every symbol recorded as blocked, none sent
    expect(dbStore.every((r) => r.outcome === 'blocked')).toBe(true);
    expect(dbStore).toHaveLength(WATCHLIST.length);
    expect(res.skipped.blocked).toBe(WATCHLIST.length);
  });

  it('a symbol in cooldown -> NO send for it, recordAlert cooldown (silent)', async () => {
    wireBuildReal(); // all would pass
    // AAPL alerted 1h ago -> cooldown; it must be skipped silently.
    dbSeed({ symbol: 'AAPL', outcome: 'sent', alerted_at: new Date(OPEN_NOW.getTime() - 3_600_000).toISOString(), scan_date: '2026-06-24' });

    const res = await runScan({ chatId: '555', telegram_user_id: '42', now: OPEN_NOW, sleepMs: 0 });

    const aapl = res.details.find((d) => d.symbol === 'AAPL');
    expect(aapl?.outcome).toBe('cooldown');
    // AAPL was never built (cooldown short-circuits before the pipeline)…
    const builtSymbols = buildRealMock.mock.calls.map((c) => c[0]);
    expect(builtSymbols).not.toContain('AAPL');
    // …and no card was ever sent for AAPL.
    const sentForAapl = sendProposalCardMock.mock.calls.some((c) => c[1].symbol === 'AAPL');
    expect(sentForAapl).toBe(false);
  });

  it('daily cap reached mid-scan -> remaining passing symbols NOT sent', async () => {
    wireBuildReal(); // all pass
    // Pre-seed (cap - 1) sent rows today so exactly ONE more send is allowed.
    for (let i = 0; i < SCAN_LIMITS.max_alerts_per_day - 1; i++) {
      dbSeed({ symbol: `PRE${i}`, outcome: 'sent', scan_date: '2026-06-24', alerted_at: OPEN_NOW.toISOString() });
    }

    const res = await runScan({ chatId: '555', telegram_user_id: '42', now: OPEN_NOW, sleepMs: 0 });

    // Only one card goes out; the cap re-check inside the loop stops the rest.
    expect(res.sent).toBe(1);
    expect(sendProposalCardMock).toHaveBeenCalledTimes(1);
    // Everyone after the cap is hit is recorded daily_cap, silently.
    expect(res.skipped.daily_cap).toBe(WATCHLIST.length - 1);
  });

  it('binds minted nonces to the owner (SCAN_OWNER) telegram_user_id', async () => {
    const fails = new Set(WATCHLIST.filter((s) => s !== 'AAPL'));
    wireBuildReal(fails);

    await runScan({ chatId: '555', telegram_user_id: 'owner-9000', now: OPEN_NOW, sleepMs: 0 });

    expect(mintNonceMock).toHaveBeenCalledTimes(3);
    for (const call of mintNonceMock.mock.calls) {
      expect(call[0].telegram_user_id).toBe('owner-9000');
    }
    // and the owner id is threaded into the build step too
    expect(buildRealMock.mock.calls[0][2]).toBe('owner-9000');
  });

  it('a per-symbol throw is captured as error, never sinks the scan', async () => {
    wireBuildReal();
    buildRealMock.mockImplementationOnce(async () => {
      throw new Error('feed exploded');
    });

    const res = await runScan({ chatId: '555', telegram_user_id: '42', now: OPEN_NOW, sleepMs: 0 });

    expect(res.scanned).toBe(WATCHLIST.length);
    expect(res.skipped.error).toBe(1);
    expect(res.details.some((d) => d.outcome === 'error')).toBe(true);
    // the remaining symbols are still processed: 6 would pass, but the daily cap
    // (5) lets only 5 through — proving the scan kept going after the throw.
    expect(res.sent).toBe(SCAN_LIMITS.max_alerts_per_day);
  });
});
