import { describe, it, expect } from 'vitest'
import { formatProposalCard, formatDecidedCard, escapeHtml } from '../telegram'
import { buildProposal } from '../build-proposal'
import type { CostModel } from '../proposal'
import type { Quote } from '../feed'

// Pure rendering — no network, no mocks needed.

const COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
}

const QUOTE: Quote = { symbol: 'AAPL', price: 100, asOf: 1_700_000_000_000, prevClose: 100 }

function card(thesis: string) {
  return buildProposal({
    // proposal_id with underscores — the exact shape the bot mints. It isn't in
    // the card body, but underscore-bearing VALUES (setup/regime/cluster) are,
    // and these are what opened the unbalanced legacy-Markdown entity.
    proposal_id: 'prop_AAPL_1782138000000',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    setup: 'trend_pullback', // underscore
    direction: 'long',
    quote: QUOTE,
    entry_price: 100,
    stop_price: 98,
    target_price: 105,
    regime: { regime: 'trending_up', adx_14: 31, atr_ratio: 1.05, price_above_ema20: true, regime_date: '2026-06-22' }, // underscore
    quality_score: 8,
    setup_sample_size: 12,
    strategy_health: 'green',
    capital: 2500,
    risk_pct: 0.005,
    currency: 'USD',
    correlation_cluster: 'megacap_tech', // underscore
    cluster_risk_pct_after: 0.005,
    current_drawdown_pct: 0,
    expected_hold_days: 5,
    costs: COSTS,
    ai_thesis: thesis,
  })
}

describe('escapeHtml', () => {
  it('encodes the three HTML-significant chars (& first)', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })
})

describe('formatProposalCard — entity-safe HTML', () => {
  it('HTML-encodes <, >, & in interpolated values', () => {
    const out = formatProposalCard(card('breakout > prior & under_pressure *fast*'))
    expect(out).toContain('breakout &gt; prior &amp; under_pressure *fast*')
    // the raw, unescaped form must NOT survive
    expect(out).not.toContain('breakout > prior &')
  })

  it('leaves underscores/asterisks literal — no Markdown entity is opened', () => {
    const out = formatProposalCard(card('plain thesis'))
    // underscore-bearing values render as-is and are safe under HTML parse mode
    expect(out).toContain('trend_pullback')
    expect(out).toContain('trending_up')
    expect(out).toContain('megacap_tech')
    // labels use HTML bold, never Markdown emphasis (which 400'd on stray '_')
    expect(out).toContain('<b>Proposal — AAPL</b>')
    expect(out).not.toContain('*Proposal')
  })

  it('a thesis with underscores AND asterisks stays literal (the reported failure)', () => {
    const out = formatProposalCard(card('momentum_break with *stars* and prop_AAPL_1782138000000'))
    expect(out).toContain('momentum_break with *stars* and prop_AAPL_1782138000000')
    // no leftover HTML-significant chars from values means nothing to mis-parse
    expect(out).not.toContain('<i>')
  })
})

describe('formatDecidedCard — post-decision lock', () => {
  it('escapes the status label + timestamp and embeds the HTML card body', () => {
    const out = formatDecidedCard(card('plain thesis'), '✅ Approved', '2026-06-23T01:00:00.000Z')
    expect(out).toContain('<b>✅ Approved</b>')
    expect(out).toContain('2026-06-23T01:00:00.000Z')
    expect(out).toContain('<b>Proposal — AAPL</b>')
    // same HTML body, so it can't 400 where the original card succeeded
    expect(out).toContain('trend_pullback')
  })
})
