/**
 * lib/feeds/alpaca.ts — Real US-equities MarketFeed backed by Alpaca market data
 * (free/basic IEX tier). Drop-in replacement for FixtureFeed: same MarketFeed
 * signatures (assetClass / getBars / getQuote), so nothing downstream changes.
 *
 * Two design decisions forced by the smoke test:
 *
 *  1. getBars OVER-FETCHES BY DATE, then slices. Holidays/weekends mean a fixed
 *     calendar window yields a variable bar count (40 cal days ≈ 26 trading
 *     days). Regime math needs ≥28 daily candles or it throws, so we request a
 *     generous start-date window (never a hardcoded count), page until we have
 *     enough, then return the most recent `lookback` bars ascending.
 *
 *  2. getQuote PREFERS THE LATEST TRADE, not the quote. Out of hours the
 *     quotes/latest ask comes back 0 (smoke test: ap:0, as:0). A 0 price would
 *     corrupt position sizing and R math, so we fail closed: trade price first,
 *     quote bid/mid as fallback, and THROW if no positive price can be derived.
 *
 * Auth: two headers on every request (APCA-API-KEY-ID / APCA-API-SECRET-KEY),
 * never a URL token. Keys come from the constructor or process.env — never
 * hardcoded. Non-200 throws (fail-closed); 401 (auth) and 403 (tier) are
 * distinguished in the error message.
 */

import type { MarketFeed, Bar, Quote, Timeframe, AssetClass } from '../feed';

const DATA_BASE = 'https://data.alpaca.markets';

/** Raw Alpaca daily/intraday bar shape (subset we use). */
interface AlpacaBar {
  t: string; // ISO open time
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

interface AlpacaBarsResponse {
  bars?: AlpacaBar[] | null;
  next_page_token?: string | null;
}

interface AlpacaTradeResponse {
  trade?: { p?: number; t?: string } | null;
}

interface AlpacaQuoteResponse {
  quote?: { bp?: number; ap?: number; t?: string } | null;
}

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
}

export class AlpacaFeed implements MarketFeed {
  readonly assetClass: AssetClass = 'us_equity';
  private readonly keyId: string;
  private readonly secretKey: string;

  /**
   * Credentials are injected (testable) or read from the environment. Throws
   * early if neither path yields a key — a feed with no auth is useless.
   */
  constructor(creds?: Partial<AlpacaCredentials>) {
    const keyId = creds?.keyId ?? process.env.ALPACA_API_KEY_ID ?? '';
    const secretKey = creds?.secretKey ?? process.env.ALPACA_API_SECRET_KEY ?? '';
    if (!keyId || !secretKey) {
      throw new Error('AlpacaFeed: missing ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY');
    }
    this.keyId = keyId;
    this.secretKey = secretKey;
  }

  private headers(): Record<string, string> {
    return {
      'APCA-API-KEY-ID': this.keyId,
      'APCA-API-SECRET-KEY': this.secretKey,
    };
  }

  /**
   * GET an Alpaca data URL and return parsed JSON. Throws on non-200, with 401
   * (auth) and 403 (tier/subscription) called out distinctly so the caller can
   * tell a bad key from a paywalled resource.
   */
  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new Error(`AlpacaFeed: 401 auth error (check API key/secret headers): ${body}`);
      }
      if (res.status === 403) {
        throw new Error(`AlpacaFeed: 403 tier/subscription error (resource not on this plan): ${body}`);
      }
      throw new Error(`AlpacaFeed: HTTP ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  /** Map our Timeframe to Alpaca's. Only daily is wired; 4h is unsupported for now. */
  private alpacaTimeframe(timeframe: Timeframe): string {
    if (timeframe === '1d') return '1Day';
    throw new Error(`AlpacaFeed: unsupported timeframe '${timeframe}' (only '1d' is supported)`);
  }

  async getBars(symbol: string, timeframe: Timeframe, lookback: number): Promise<Bar[]> {
    const tf = this.alpacaTimeframe(timeframe);

    // Over-fetch by a generous calendar window — NEVER a hardcoded bar count.
    // Weekends/holidays mean ~30% of calendar days have no bar, so widen the
    // window well past `lookback` and slice the most recent `lookback` after.
    const calendarDays = Math.max(lookback * 2, 130);
    const start = new Date(Date.now() - calendarDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const collected: AlpacaBar[] = [];
    let pageToken: string | undefined;
    // Page until no token. (limit=1000 per page; daily windows are tiny, but a
    // 4h/intraday window could need several pages — loop is cheap insurance.)
    do {
      const params = new URLSearchParams({
        timeframe: tf,
        adjustment: 'raw',
        start,
        limit: '1000',
      });
      if (pageToken) params.set('page_token', pageToken);
      const url = `${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`;
      const data = await this.get<AlpacaBarsResponse>(url);
      if (Array.isArray(data.bars)) collected.push(...data.bars);
      pageToken = data.next_page_token ?? undefined;
    } while (pageToken);

    // Normalise ISO t -> epoch ms, then sort ascending (oldest-first) to match
    // the MarketFeed/FixtureFeed convention regardless of Alpaca's page order.
    const bars: Bar[] = collected
      .map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
      .sort((a, b) => a.t - b.t);

    // Return the most recent `lookback` bars (ascending). Caller decides whether
    // the count it got is sufficient (regime throws if <28); we never pad.
    return bars.slice(-lookback);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const { price, asOf } = await this.derivePrice(symbol);

    // prevClose drives the >3% sanity check. Per design, fetch the last two daily
    // bars and use the OLDER bar's close (the prior session's close relative to
    // the most recent bar). Optional field — if we can't get two bars, omit it
    // rather than fail the whole quote.
    let prevClose: number | undefined;
    try {
      const recent = await this.getBars(symbol, '1d', 2);
      if (recent.length >= 2 && recent[0].c > 0) prevClose = recent[0].c;
    } catch {
      prevClose = undefined;
    }

    return { symbol, price, asOf, prevClose };
  }

  /**
   * Derive a TRUSTWORTHY positive price. Primary: latest trade (immune to the
   * after-hours zero-ask problem). Fallback: latest quote — bid if ask is 0,
   * else the bid/ask mid. Throws if no positive price can be derived from
   * either source (fail-closed: a 0 entry corrupts sizing + R).
   */
  private async derivePrice(symbol: string): Promise<{ price: number; asOf: number }> {
    // Primary — latest trade.
    const trade = await this.get<AlpacaTradeResponse>(
      `${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
    );
    const tp = trade.trade?.p;
    if (typeof tp === 'number' && tp > 0) {
      return { price: tp, asOf: this.toMs(trade.trade?.t) };
    }

    // Fallback — latest quote. Use bid when ask is 0; else the mid.
    const quote = await this.get<AlpacaQuoteResponse>(
      `${DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
    );
    const bp = quote.quote?.bp ?? 0;
    const ap = quote.quote?.ap ?? 0;
    let price = 0;
    if (bp > 0 && ap > 0) price = (bp + ap) / 2;
    else if (ap === 0 && bp > 0) price = bp;
    else if (bp === 0 && ap > 0) price = ap;

    if (price > 0) return { price, asOf: this.toMs(quote.quote?.t) };

    throw new Error(`AlpacaFeed: no valid price for ${symbol}`);
  }

  /** ISO timestamp -> epoch ms; missing/invalid falls back to now (still a real freshness anchor). */
  private toMs(iso?: string): number {
    if (!iso) return Date.now();
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : Date.now();
  }
}
