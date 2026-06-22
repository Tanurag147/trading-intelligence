import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the route's I/O edges. @/lib/propose is mocked with importActual so
// buildFixtureProposalInput (and the rest) stay REAL while runProposal is a spy —
// that lets us assert the command wires a real, symbol-bound args object into
// runProposal without actually persisting or sending anything.
const { sendMessageMock, runProposalMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(),
  runProposalMock: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/telegram', () => ({
  sendMessage: sendMessageMock,
  regimeEmoji: () => '',
  answerCallbackQuery: vi.fn(),
  editMessageText: vi.fn(),
  escapeHtml: (s: string) => s,
  formatProposalCard: () => 'CARD',
  formatDecidedCard: () => 'CARD',
}))
vi.mock('@/lib/trading', () => ({
  calculatePositionSize: () => ({ units: 0, riskAmount: 0, riskPct: 0 }),
  calculateRRRatio: () => 0,
  minimumTarget: () => 0,
}))
vi.mock('@/lib/persist', () => ({ saveDecision: vi.fn(), saveProposal: vi.fn() }))
vi.mock('@/lib/nonce', () => ({ mintNonce: vi.fn(), verifyAndBurnNonce: vi.fn() }))
vi.mock('@/lib/propose', async () => {
  const actual = await vi.importActual<typeof import('@/lib/propose')>('@/lib/propose')
  return { ...actual, runProposal: runProposalMock }
})

import { POST } from '@/app/api/telegram/route'
import { buildFixtureProposalInput, type RunProposalArgs } from '@/lib/propose'
import { buildProposal } from '@/lib/build-proposal'
import { validateProposalRisk } from '@/lib/risk-gate'

function req(text: string, fromId = 42): Request {
  return new Request('http://localhost/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { chat: { id: 555 }, from: { id: fromId }, text } }),
  })
}

let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(undefined)
  runProposalMock.mockReset().mockResolvedValue({ proposal_id: 'x', gate_passed: true, sent: true })
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('trading:propose command wiring', () => {
  it('propose AAPL → runProposal invoked with symbol AAPL (card+buttons path)', async () => {
    const res = await POST(req('trading:propose AAPL'))

    expect(res.status).toBe(200)
    expect(runProposalMock).toHaveBeenCalledTimes(1)
    const passed = runProposalMock.mock.calls[0][0] as RunProposalArgs
    expect(passed.symbol).toBe('AAPL')
    expect(passed.chatId).toBe('555')
    expect(passed.telegram_user_id).toBe('42')
    // a valid symbol never falls through to a usage / unknown-command message
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('propose with NO symbol → usage message, runProposal NOT called', async () => {
    const res = await POST(req('trading:propose'))

    expect(res.status).toBe(200)
    expect(runProposalMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendMessageMock.mock.calls[0]
    expect(chatId).toBe('555')
    expect(text).toContain('Usage')
    expect(text).toContain('trading:propose')
  })

  it('propose DOGE → universe rejection, runProposal NOT called', async () => {
    const res = await POST(req('trading:propose DOGE'))

    expect(res.status).toBe(200)
    expect(runProposalMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    const [, text] = sendMessageMock.mock.calls[0]
    expect(text).toContain('DOGE')
    expect(text).toContain('not in the proposal universe')
  })

  it('lowercase `propose aapl` works (symbol upper-cased into runProposal)', async () => {
    const res = await POST(req('trading:propose aapl'))

    expect(res.status).toBe(200)
    expect(runProposalMock).toHaveBeenCalledTimes(1)
    expect((runProposalMock.mock.calls[0][0] as RunProposalArgs).symbol).toBe('AAPL')
  })

  it('runProposal throws → still 200, error reply sent, no crash', async () => {
    runProposalMock.mockRejectedValue(new Error('boom'))

    const res = await POST(req('trading:propose NVDA'))

    expect(res.status).toBe(200)
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    const [, text] = sendMessageMock.mock.calls[0]
    expect(text).toContain("Couldn't build proposal for NVDA")
    expect(errorSpy).toHaveBeenCalledWith('propose failed', expect.any(Error))
  })

  it('help text lists propose', async () => {
    await POST(req('trading:help'))
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock.mock.calls[0][1]).toContain('trading:propose')
  })
})

describe('buildFixtureProposalInput', () => {
  it('maps clusters: NVDA→ai_cluster, AAPL→megacap_tech, SPY→etf_cluster', () => {
    expect(buildFixtureProposalInput('NVDA', '1', '2').build.correlation_cluster).toBe('ai_cluster')
    expect(buildFixtureProposalInput('AAPL', '1', '2').build.correlation_cluster).toBe('megacap_tech')
    expect(buildFixtureProposalInput('SPY', '1', '2').build.correlation_cluster).toBe('etf_cluster')
  })

  it('seeds a feed whose getQuote resolves for the (upper-cased) symbol', async () => {
    const a = buildFixtureProposalInput('aapl', '555', '42')
    expect(a.symbol).toBe('AAPL')
    const q = await a.feed.getQuote('AAPL')
    expect(q.price).toBe(100)
    const bars = await a.feed.getBars('AAPL', '1d', 3)
    expect(bars.length).toBeGreaterThan(0)
  })

  it('produces a card that PASSES the risk gate', async () => {
    const a = buildFixtureProposalInput('MSFT', '555', '42')
    const quote = await a.feed.getQuote('MSFT')
    const card = buildProposal({ ...a.build, symbol: 'MSFT', quote })
    const gate = validateProposalRisk({ card, ctx: a.ctx })
    expect(gate.passed).toBe(true)
    expect(gate.blocks).toEqual([])
  })
})
