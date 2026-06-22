import { describe, it, expect, vi, beforeEach } from 'vitest'

// A chainable, thenable supabase mock. `from(table)` returns a builder whose
// select/eq/neq/in are no-op chain links (the real WHERE is simulated by the
// per-table data we set), and which is awaitable to { data, error }. upsert
// records its (table, row, opts) so we can assert writes + idempotency.
interface QueryResult {
  data: unknown
  error: unknown
}
interface MockState {
  tableData: Record<string, QueryResult>
  upserts: Array<{ table: string; row: Record<string, unknown>; opts: unknown }>
  filters: Array<[string, string, unknown]> // [table, column, value] for eq/neq
  ins: Array<{ table: string; column: string; values: unknown }>
}

const { state, supabaseMock } = vi.hoisted(() => {
  const state: MockState = { tableData: {}, upserts: [], filters: [], ins: [] }
  const supabaseMock = {
    from(table: string) {
      const result: QueryResult = state.tableData[table] ?? { data: [], error: null }
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          state.filters.push([table, column, value])
          return builder
        },
        neq: (column: string, value: unknown) => {
          state.filters.push([table, column, value])
          return builder
        },
        in: (column: string, values: unknown) => {
          state.ins.push({ table, column, values })
          return builder
        },
        upsert: (row: Record<string, unknown>, opts: unknown) => {
          state.upserts.push({ table, row, opts })
          return Promise.resolve({ error: null })
        },
        then: <T>(onF: (r: QueryResult) => T, onR?: (e: unknown) => T): Promise<T> =>
          Promise.resolve(result).then(onF, onR),
      }
      return builder
    },
  }
  return { state, supabaseMock }
})
vi.mock('../supabase', () => ({ supabase: supabaseMock }))

import {
  findUnresolvedShadows,
  resolveShadow,
  runShadowTracker,
} from '../shadow-tracker'
import { buildProposal } from '../build-proposal'
import type { ProposalCard } from '../proposal'
import type { CostModel } from '../proposal'
import type { Bar } from '../feed'

const COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
}

function card(proposal_id: string, symbol = 'AAPL'): ProposalCard {
  return buildProposal({
    proposal_id,
    symbol,
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
    quote: { symbol, price: 100, asOf: 1_700_000_000_000, prevClose: 100 },
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
  })
}

const t0 = 1_700_000_000_000
const day = 24 * 60 * 60 * 1000
// Bars that walk up and clear 105 → target_hit (lows never touch the 98 stop).
const RISING: Bar[] = [
  { t: t0 + day, o: 100, h: 103, l: 99.5, c: 102 },
  { t: t0 + 2 * day, o: 102, h: 106, l: 101, c: 105 },
]
// One bar whose low pierces the 98 stop → stopped.
const FALLING: Bar[] = [{ t: t0 + day, o: 100, h: 100.5, l: 97, c: 97.5 }]
// One inert bar inside the channel → never resolves (stays open).
const INERT: Bar[] = [{ t: t0 + day, o: 100, h: 101, l: 99, c: 100 }]

beforeEach(() => {
  state.tableData = {}
  state.upserts = []
  state.filters = []
  state.ins = []
})

describe('findUnresolvedShadows', () => {
  it('returns only route_to_shadow rows with no CLOSED shadow result (anti-join)', async () => {
    state.tableData = {
      trading_decisions: { data: [{ proposal_id: 'A' }, { proposal_id: 'B' }], error: null },
      trading_shadow_results: { data: [{ proposal_id: 'A' }], error: null }, // A already closed
      trading_proposals: { data: [{ proposal_id: 'B', card_json: card('B') }], error: null },
    }

    const out = await findUnresolvedShadows()

    expect(out.map((o) => o.proposal_id)).toEqual(['B'])
    expect(out[0].card.proposal_id).toBe('B')
    // resolved-set query must exclude still-open rows
    expect(state.filters).toContainEqual(['trading_shadow_results', 'status', 'open'])
    // only the unresolved id is hydrated
    expect(state.ins).toContainEqual({ table: 'trading_proposals', column: 'proposal_id', values: ['B'] })
  })

  it('filters decisions by route_to_shadow=true (a non-routed skip is never picked up)', async () => {
    state.tableData = {
      trading_decisions: { data: [], error: null },
    }

    const out = await findUnresolvedShadows()

    expect(out).toEqual([])
    expect(state.filters).toContainEqual(['trading_decisions', 'route_to_shadow', true])
  })

  it('throws on a db error', async () => {
    state.tableData = { trading_decisions: { data: null, error: { message: 'boom' } } }
    await expect(findUnresolvedShadows()).rejects.toEqual({ message: 'boom' })
  })
})

describe('resolveShadow (pure, via the existing exit stepper)', () => {
  it('rising bars → target_hit, realised_r > 0', () => {
    const state = resolveShadow(card('R'), RISING)
    expect(state.status).toBe('target_hit')
    expect(state.realised_r).not.toBeNull()
    expect(state.realised_r as number).toBeGreaterThan(0)
  })

  it('falling bars → stopped, realised_r < 0', () => {
    const state = resolveShadow(card('S'), FALLING)
    expect(state.status).toBe('stopped')
    expect(state.realised_r as number).toBeLessThan(0)
  })
})

describe('runShadowTracker', () => {
  function seed(ids: string[], proposals = ids): void {
    state.tableData = {
      trading_decisions: { data: ids.map((proposal_id) => ({ proposal_id })), error: null },
      trading_shadow_results: { data: [], error: null }, // nothing closed yet
      trading_proposals: {
        data: proposals.map((proposal_id) => ({ proposal_id, card_json: card(proposal_id) })),
        error: null,
      },
    }
  }

  it('persists one shadow result per shadow and counts resolved correctly', async () => {
    seed(['A', 'B'])

    const summary = await runShadowTracker({
      feed: { assetClass: 'us_equity', getBars: async () => RISING, getQuote: async () => ({ symbol: 'AAPL', price: 100, asOf: t0 }) },
      barsFor: async () => RISING,
    })

    expect(summary).toMatchObject({ scanned: 2, resolved: 2, still_open: 0 })
    const shadowWrites = state.upserts.filter((u) => u.table === 'trading_shadow_results')
    expect(shadowWrites).toHaveLength(2)
    // saveShadowResult derives the would_have_* flags from the resolved state
    expect(shadowWrites[0].row.status).toBe('target_hit')
    expect(shadowWrites[0].row.would_have_hit_target).toBe(true)
    expect(shadowWrites[0].row.would_have_won).toBe(true)
    expect(shadowWrites[0].opts).toEqual({ onConflict: 'proposal_id' })
  })

  it('a shadow whose bars run out is counted still_open, not resolved', async () => {
    seed(['C'])

    const summary = await runShadowTracker({
      feed: { assetClass: 'us_equity', getBars: async () => INERT, getQuote: async () => ({ symbol: 'AAPL', price: 100, asOf: t0 }) },
      barsFor: async () => INERT,
    })

    expect(summary).toMatchObject({ scanned: 1, resolved: 0, still_open: 1 })
    const write = state.upserts.find((u) => u.table === 'trading_shadow_results')
    expect(write?.row.status).toBe('open')
  })

  it('is idempotent: re-running a still-open shadow overwrites it with the newer verdict', async () => {
    seed(['D'])

    // 1st run: bars run out → still open, written as status 'open'.
    const first = await runShadowTracker({
      feed: { assetClass: 'us_equity', getBars: async () => INERT, getQuote: async () => ({ symbol: 'AAPL', price: 100, asOf: t0 }) },
      barsFor: async () => INERT,
    })
    expect(first).toMatchObject({ resolved: 0, still_open: 1 })

    // shadow_results still has no CLOSED row, so D is re-picked on the next run.
    state.upserts = []
    const second = await runShadowTracker({
      feed: { assetClass: 'us_equity', getBars: async () => RISING, getQuote: async () => ({ symbol: 'AAPL', price: 100, asOf: t0 }) },
      barsFor: async () => RISING,
    })

    expect(second).toMatchObject({ resolved: 1, still_open: 0 })
    const write = state.upserts.find((u) => u.table === 'trading_shadow_results')
    expect(write?.row.status).toBe('target_hit')
    expect(write?.opts).toEqual({ onConflict: 'proposal_id' }) // upsert = overwrite
  })

  it('collects per-shadow failures without aborting the run', async () => {
    seed(['E', 'F'])

    const summary = await runShadowTracker({
      feed: { assetClass: 'us_equity', getBars: async () => RISING, getQuote: async () => ({ symbol: 'AAPL', price: 100, asOf: t0 }) },
      barsFor: async (c) => {
        if (c.proposal_id === 'E') throw new Error('no bars for E')
        return RISING
      },
    })

    expect(summary.scanned).toBe(2)
    expect(summary.resolved).toBe(1) // F still resolves
    expect(summary.failures).toHaveLength(1)
    expect(summary.failures[0]).toMatchObject({ proposal_id: 'E' })
  })
})
