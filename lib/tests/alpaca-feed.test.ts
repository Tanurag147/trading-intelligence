import { describe, it, expect, vi, afterEach } from 'vitest';
import { AlpacaFeed } from '../feeds/alpaca';

// ---- HTTP mock helpers ------------------------------------------------------
// All network is mocked; no real Alpaca calls in CI.

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

interface Routes {
  bars?: (url: string) => Response;
  trade?: () => Response;
  quote?: () => Response;
}

/** Route a mock fetch by URL substring; records calls for assertions. */
function stubFetch(routes: Routes): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes('/trades/latest') && routes.trade) return routes.trade();
    if (url.includes('/quotes/latest') && routes.quote) return routes.quote();
    if (url.includes('/bars') && routes.bars) return routes.bars(url);
    throw new Error(`unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const CREDS = { keyId: 'test-key', secretKey: 'test-secret' };
const feed = () => new AlpacaFeed(CREDS);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- constructor ------------------------------------------------------------
describe('AlpacaFeed construction', () => {
  it('is a us_equity feed', () => {
    expect(feed().assetClass).toBe('us_equity');
  });

  it('throws when credentials are missing', () => {
    const saved = { id: process.env.ALPACA_API_KEY_ID, sec: process.env.ALPACA_API_SECRET_KEY };
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
    try {
      expect(() => new AlpacaFeed()).toThrow(/missing/i);
    } finally {
      if (saved.id !== undefined) process.env.ALPACA_API_KEY_ID = saved.id;
      if (saved.sec !== undefined) process.env.ALPACA_API_SECRET_KEY = saved.sec;
    }
  });
});

// ---- getBars ----------------------------------------------------------------
describe('AlpacaFeed.getBars', () => {
  it('maps Alpaca bars -> Bar (ISO t -> epoch ms, o/h/l/c/v)', async () => {
    const iso = '2026-06-22T04:00:00Z';
    stubFetch({
      bars: () => res(200, { bars: [{ t: iso, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }] }),
    });
    const bars = await feed().getBars('AAPL', '1d', 30);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ t: Date.parse(iso), o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });
    expect(typeof bars[0].t).toBe('number');
  });

  it('over-fetches by date then returns exactly `lookback` most-recent bars, ascending', async () => {
    // Mock returns 5 bars OUT OF ORDER; request only the 3 most recent.
    const raw = [
      { t: '2026-06-20T04:00:00Z', o: 20, h: 20, l: 20, c: 20, v: 1 },
      { t: '2026-06-18T04:00:00Z', o: 18, h: 18, l: 18, c: 18, v: 1 },
      { t: '2026-06-22T04:00:00Z', o: 22, h: 22, l: 22, c: 22, v: 1 },
      { t: '2026-06-19T04:00:00Z', o: 19, h: 19, l: 19, c: 19, v: 1 },
      { t: '2026-06-21T04:00:00Z', o: 21, h: 21, l: 21, c: 21, v: 1 },
    ];
    const fn = stubFetch({ bars: () => res(200, { bars: raw }) });

    const bars = await feed().getBars('AAPL', '1d', 3);

    // exactly `lookback`, the 3 most recent, ascending by t
    expect(bars.map((b) => b.c)).toEqual([20, 21, 22]);
    for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);

    // the request used a wide START-DATE window + high limit, NOT a count == lookback.
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('timeframe=1Day');
    expect(url).toContain('limit=1000');
    expect(url).toMatch(/start=\d{4}-\d{2}-\d{2}/);
    expect(url).not.toContain('limit=3');
  });

  it('paginates: two pages combine, ascending', async () => {
    const fn = stubFetch({
      bars: (url) => {
        if (url.includes('page_token=p2')) {
          return res(200, {
            bars: [
              { t: '2026-06-21T04:00:00Z', o: 21, h: 21, l: 21, c: 21, v: 1 },
              { t: '2026-06-22T04:00:00Z', o: 22, h: 22, l: 22, c: 22, v: 1 },
            ],
            next_page_token: null,
          });
        }
        return res(200, {
          bars: [
            { t: '2026-06-19T04:00:00Z', o: 19, h: 19, l: 19, c: 19, v: 1 },
            { t: '2026-06-20T04:00:00Z', o: 20, h: 20, l: 20, c: 20, v: 1 },
          ],
          next_page_token: 'p2',
        });
      },
    });

    const bars = await feed().getBars('AAPL', '1d', 4);
    expect(bars.map((b) => b.c)).toEqual([19, 20, 21, 22]);
    expect(fn).toHaveBeenCalledTimes(2); // followed the page token
  });

  it('throws a distinct AUTH message on 401', async () => {
    stubFetch({ bars: () => res(401, { message: 'forbidden' }) });
    await expect(feed().getBars('AAPL', '1d', 30)).rejects.toThrow(/401 auth/i);
  });

  it('throws a distinct TIER message on 403', async () => {
    stubFetch({ bars: () => res(403, { message: 'subscription does not permit' }) });
    await expect(feed().getBars('AAPL', '1d', 30)).rejects.toThrow(/403 tier/i);
  });

  it('rejects an unsupported timeframe (4h not wired)', async () => {
    stubFetch({ bars: () => res(200, { bars: [] }) });
    await expect(feed().getBars('AAPL', '4h', 30)).rejects.toThrow(/unsupported timeframe/i);
  });
});

// ---- getQuote ---------------------------------------------------------------
describe('AlpacaFeed.getQuote', () => {
  const prevCloseBars = () =>
    res(200, {
      bars: [
        { t: '2026-06-20T04:00:00Z', o: 190, h: 190, l: 190, c: 190, v: 1 },
        { t: '2026-06-22T04:00:00Z', o: 195, h: 195, l: 195, c: 195, v: 1 },
      ],
    });

  it('prefers the latest TRADE price and sets asOf from its timestamp', async () => {
    const tIso = '2026-06-23T20:00:02Z';
    stubFetch({
      trade: () => res(200, { trade: { p: 200.5, t: tIso } }),
      bars: () => prevCloseBars(),
    });

    const q = await feed().getQuote('AAPL');
    expect(q.symbol).toBe('AAPL');
    expect(q.price).toBe(200.5);
    expect(q.asOf).toBe(Date.parse(tIso)); // freshness anchor from the trade ts
    expect(q.prevClose).toBe(190); // older of the two daily bars
  });

  it('falls back to the BID when the ask is 0 (the after-hours zero-ask case)', async () => {
    const qIso = '2026-06-23T20:00:02Z';
    stubFetch({
      trade: () => res(200, { trade: { p: 0 } }), // no usable trade price
      quote: () => res(200, { quote: { bp: 293.36, ap: 0, t: qIso } }),
      bars: () => prevCloseBars(),
    });

    const q = await feed().getQuote('AAPL');
    expect(q.price).toBe(293.36); // bid, since ask is 0
    expect(q.asOf).toBe(Date.parse(qIso));
  });

  it('uses the bid/ask MID when both sides are positive', async () => {
    stubFetch({
      trade: () => res(200, { trade: { p: 0 } }),
      quote: () => res(200, { quote: { bp: 100, ap: 102, t: '2026-06-23T20:00:00Z' } }),
      bars: () => prevCloseBars(),
    });
    const q = await feed().getQuote('AAPL');
    expect(q.price).toBe(101);
  });

  it('THROWS when no trade price and both bid and ask are 0 (zero-price guard)', async () => {
    stubFetch({
      trade: () => res(200, { trade: { p: 0 } }),
      quote: () => res(200, { quote: { bp: 0, ap: 0, t: '2026-06-23T20:00:00Z' } }),
    });
    await expect(feed().getQuote('AAPL')).rejects.toThrow(/no valid price for AAPL/);
  });

  it('still returns a quote (no prevClose) if the daily-bar lookup fails', async () => {
    stubFetch({
      trade: () => res(200, { trade: { p: 200, t: '2026-06-23T20:00:00Z' } }),
      bars: () => res(403, { message: 'nope' }), // prevClose fetch fails -> swallowed
    });
    const q = await feed().getQuote('AAPL');
    expect(q.price).toBe(200);
    expect(q.prevClose).toBeUndefined();
  });
});
