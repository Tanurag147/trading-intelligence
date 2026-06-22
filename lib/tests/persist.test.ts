import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the supabase singleton Proxy: NO network ever happens ------------
// vi.hoisted gives us handles the hoisted vi.mock factory can close over.
const { fromMock, upsertMock } = vi.hoisted(() => {
  const upsertMock = vi.fn();
  const fromMock = vi.fn(() => ({ upsert: upsertMock }));
  return { fromMock, upsertMock };
});
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }));

import { saveProposal, saveDecision, saveShadowResult } from '../persist';
import { buildProposal, type BuildProposalInput, type RegimeInput } from '../build-proposal';
import { validateProposalRisk } from '../risk-gate';
import { decide } from '../decide';
import { initPosition, stepPosition } from '../exit-stepper';
import { cleanCard } from './factory';
import type { CostModel } from '../proposal';
import type { Quote, Bar } from '../feed';

const COSTS: CostModel = {
  entry_slippage_pct: 0.0005,
  stop_slippage_pct: 0.0015,
  fast_exit_slippage_pct: 0.0025,
  fee_pct: 0.001,
  spread_pct: 0.0005,
};

function quote(): Quote {
  return { symbol: 'AAPL', price: 100, asOf: 1_700_000_000_000, prevClose: 99.5 };
}
function trendingRegime(over: Partial<RegimeInput> = {}): RegimeInput {
  return { regime: 'trending_up', adx_14: 31.2, atr_ratio: 1.05, price_above_ema20: true, regime_date: '2026-06-22', ...over };
}
function buildInput(over: Partial<BuildProposalInput> = {}): BuildProposalInput {
  return {
    proposal_id: 'p_persist_0001',
    symbol: 'AAPL',
    asset_class: 'us_equity',
    setup: 'trend_pullback',
    direction: 'long',
    quote: quote(),
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
function bar(over: Partial<Bar> = {}): Bar {
  return { t: 1_700_000_000_000, o: 100, h: 100, l: 100, c: 100, ...over };
}

// The (row, opts) pair handed to the latest .upsert() call.
function lastUpsert(): { row: Record<string, unknown>; opts: { onConflict?: string } } {
  const call = upsertMock.mock.calls.at(-1);
  if (!call) throw new Error('upsert was not called');
  return { row: call[0] as Record<string, unknown>, opts: (call[1] ?? {}) as { onConflict?: string } };
}

beforeEach(() => {
  fromMock.mockClear();
  upsertMock.mockReset();
  upsertMock.mockResolvedValue({ error: null });
});

describe('saveProposal', () => {
  it('upserts into trading_proposals onConflict proposal_id with mapped fields', async () => {
    const card = buildProposal(buildInput());
    const gate = validateProposalRisk({ card, ctx: { total_open_risk_pct: 0, cluster_risk_pct: 0, trades_this_week: 0, consecutive_losses: 0, current_drawdown_pct: 0, strategy_health: 'green', data_integrity_ok: true, in_macro_blackout: false, earnings_in_window: false } });

    await saveProposal(card, gate);

    expect(fromMock).toHaveBeenCalledWith('trading_proposals');
    const { row, opts } = lastUpsert();
    expect(opts.onConflict).toBe('proposal_id');
    expect(row.proposal_id).toBe(card.proposal_id);
    expect(row.regime_tier).toBe(card.regime.tier);
    expect(row.regime_tier).toBe(4);
    expect(row.net_r).toBe(card.expectancy.net_r);
    expect(row.gate_passed).toBe(gate.passed);
    expect(row.gate_blocks).toBe(gate.blocks);
    expect(row.stop_price).toBe(card.exit.stop_price);
    expect(row.target_price).toBe(card.exit.target_price);
    expect(row.card_json).toBe(card);
    // epoch ms -> ISO at the boundary
    expect(row.created_at).toBe(new Date(card.created_at).toISOString());
  });

  it('throws when supabase returns an error (fail-closed)', async () => {
    upsertMock.mockResolvedValue({ error: new Error('db down') });
    const card = cleanCard();
    const gate = validateProposalRisk({ card, ctx: { total_open_risk_pct: 0, cluster_risk_pct: 0, trades_this_week: 0, consecutive_losses: 0, current_drawdown_pct: 0, strategy_health: 'green', data_integrity_ok: true, in_macro_blackout: false, earnings_in_window: false } });
    await expect(saveProposal(card, gate)).rejects.toThrow('db down');
  });
});

describe('saveDecision', () => {
  it('maps outcome + accepted + route_to_shadow for a skip', async () => {
    const card = cleanCard();
    const gate = validateProposalRisk({ card, ctx: { total_open_risk_pct: 0, cluster_risk_pct: 0, trades_this_week: 0, consecutive_losses: 0, current_drawdown_pct: 0, strategy_health: 'green', data_integrity_ok: true, in_macro_blackout: false, earnings_in_window: false } });
    const rec = decide({ card, gate, decision: 'skip', reason_code: 'weak_conviction', decided_at: 1_700_000_000_000 });

    await saveDecision(rec);

    expect(fromMock).toHaveBeenCalledWith('trading_decisions');
    const { row, opts } = lastUpsert();
    expect(opts.onConflict).toBe('proposal_id');
    expect(row.outcome).toBe('skipped');
    expect(row.accepted).toBe(true);
    expect(row.route_to_shadow).toBe(true);
    expect(row.reason_code).toBe('weak_conviction');
    expect(row.decided_at).toBe(new Date(rec.decided_at).toISOString());
    expect(row.resnooze_until).toBeNull();
    expect(row.decision_json).toBe(rec);
  });

  it('maps resnooze_until to ISO for a snooze', async () => {
    const card = cleanCard();
    const gate = validateProposalRisk({ card, ctx: { total_open_risk_pct: 0, cluster_risk_pct: 0, trades_this_week: 0, consecutive_losses: 0, current_drawdown_pct: 0, strategy_health: 'green', data_integrity_ok: true, in_macro_blackout: false, earnings_in_window: false } });
    const rec = decide({ card, gate, decision: 'snooze', decided_at: 1_700_000_000_000 });

    await saveDecision(rec);
    const { row } = lastUpsert();
    expect(row.resnooze_until).toBe(new Date(rec.resnooze_until as number).toISOString());
  });

  it('throws when supabase returns an error', async () => {
    upsertMock.mockResolvedValue({ error: new Error('constraint') });
    const card = cleanCard();
    const gate = validateProposalRisk({ card, ctx: { total_open_risk_pct: 0, cluster_risk_pct: 0, trades_this_week: 0, consecutive_losses: 0, current_drawdown_pct: 0, strategy_health: 'green', data_integrity_ok: true, in_macro_blackout: false, earnings_in_window: false } });
    const rec = decide({ card, gate, decision: 'snooze', decided_at: 1 });
    await expect(saveDecision(rec)).rejects.toThrow('constraint');
  });
});

describe('saveShadowResult', () => {
  it('derives flags from a target_hit state', async () => {
    const card = cleanCard(); // entry 100, stop 98, target 105
    const state = stepPosition(initPosition(card), bar({ h: 106, l: 99, c: 105 }), card.exit);
    expect(state.status).toBe('target_hit');

    await saveShadowResult(card.proposal_id, state);

    expect(fromMock).toHaveBeenCalledWith('trading_shadow_results');
    const { row, opts } = lastUpsert();
    expect(opts.onConflict).toBe('proposal_id');
    expect(row.status).toBe('target_hit');
    expect(row.would_have_won).toBe(true);
    expect(row.would_have_hit_target).toBe(true);
    expect(row.would_have_stopped).toBe(false);
    expect(row.trail_activated).toBe(state.trail_active);
    expect(row.realised_r).toBe(state.realised_r);
    expect(row.resolved_at).toBe(new Date(state.exit_bar_time as number).toISOString());
    expect(row.state_json).toBe(state);
  });

  it('derives flags from a stopped state', async () => {
    const card = cleanCard();
    const state = stepPosition(initPosition(card), bar({ h: 101, l: 97, c: 97 }), card.exit);
    expect(state.status).toBe('stopped');

    await saveShadowResult(card.proposal_id, state);
    const { row } = lastUpsert();
    expect(row.status).toBe('stopped');
    expect(row.would_have_won).toBe(false); // realised_r ~ -1
    expect(row.would_have_hit_target).toBe(false);
    expect(row.would_have_stopped).toBe(true);
  });

  it('still-open state => resolved_at null', async () => {
    const card = cleanCard();
    const state = initPosition(card); // never stepped, open, exit_bar_time null
    await saveShadowResult(card.proposal_id, state);
    const { row } = lastUpsert();
    expect(row.resolved_at).toBeNull();
    expect(row.would_have_won).toBe(false); // realised_r null
  });

  it('throws when supabase returns an error', async () => {
    upsertMock.mockResolvedValue({ error: new Error('shadow fail') });
    const card = cleanCard();
    const state = initPosition(card);
    await expect(saveShadowResult(card.proposal_id, state)).rejects.toThrow('shadow fail');
  });
});
