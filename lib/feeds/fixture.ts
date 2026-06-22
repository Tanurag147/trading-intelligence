/**
 * lib/feeds/fixture.ts — A deterministic in-memory MarketFeed for tests and
 * paper-phase development. Proves the interface is implementable without a
 * network. CoinGeckoFeed / PolygonFeed implement the same shape later.
 */

import type { MarketFeed, Bar, Quote, Timeframe, AssetClass } from '../feed';

export class FixtureFeed implements MarketFeed {
  readonly assetClass: AssetClass;
  private bars: Map<string, Bar[]>;
  private quotes: Map<string, Quote>;

  constructor(assetClass: AssetClass, bars: Record<string, Bar[]>, quotes: Record<string, Quote>) {
    this.assetClass = assetClass;
    this.bars = new Map(Object.entries(bars));
    this.quotes = new Map(Object.entries(quotes));
  }

  async getBars(symbol: string, _timeframe: Timeframe, lookback: number): Promise<Bar[]> {
    const all = this.bars.get(symbol);
    if (!all) throw new Error(`FixtureFeed: no bars for ${symbol}`);
    return all.slice(-lookback);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const q = this.quotes.get(symbol);
    if (!q) throw new Error(`FixtureFeed: no quote for ${symbol}`);
    return q;
  }
}
