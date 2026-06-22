/**
 * lib/feed.ts — Market-agnostic data source contract.
 *
 * The whole point: nothing downstream knows whether bars came from CoinGecko,
 * Polygon, Finnhub, or a CSV fixture. Swapping the source = implementing this
 * one interface. Equities vs crypto is a config + adapter choice, not a rewrite.
 */

export type AssetClass = 'crypto' | 'us_equity' | 'asx_equity';

/** One OHLC bar. Timestamps are epoch ms (UTC). Volume optional (crypto OHLC often lacks it). */
export interface Bar {
  t: number; // open time, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export type Timeframe = '4h' | '1d';

/** Normalised quote used for freshness + chase checks at proposal/execution time. */
export interface Quote {
  symbol: string;
  price: number;
  asOf: number; // epoch ms — drives the Data Integrity Guard freshness check
  prevClose?: number; // drives the >3% sanity check
}

/**
 * Every concrete feed (CoinGeckoFeed, PolygonFeed, FinnhubFeed, FixtureFeed)
 * implements this. Methods are async and may throw — callers translate to
 * fail-closed "NO PROPOSAL", they never swallow silently.
 */
export interface MarketFeed {
  readonly assetClass: AssetClass;
  /** Historical bars, oldest-first, for indicator math. `lookback` = number of bars. */
  getBars(symbol: string, timeframe: Timeframe, lookback: number): Promise<Bar[]>;
  /** Latest quote, for freshness + entry/chase checks. */
  getQuote(symbol: string): Promise<Quote>;
}
