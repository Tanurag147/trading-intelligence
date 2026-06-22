/**
 * lib/persist.ts — Thin Trading OS v3 persistence. Pure mapping + write, no
 * business logic. Each function maps a pure object → a row and UPSERTs on
 * proposal_id (idempotent), throwing on error per the repo convention
 * (`const { error } = await ...; if (error) throw error`).
 *
 * Reuses the existing supabase singleton Proxy — no new client, no service-role
 * key handling here. Epoch-ms timestamps from the pure layer are converted to
 * ISO strings at the boundary; everything else is a direct field copy.
 */

import { supabase } from './supabase';
import type { ProposalCard, RiskGateResult } from './proposal';
import type { DecisionRecord } from './decide';
import type { PositionState } from './exit-stepper';

/** epoch ms → ISO 8601 string for timestamptz columns. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export async function saveProposal(card: ProposalCard, gate: RiskGateResult): Promise<void> {
  const row = {
    proposal_id: card.proposal_id,
    created_at: iso(card.created_at),
    expires_at: iso(card.expires_at),
    symbol: card.symbol,
    asset_class: card.asset_class,
    setup: card.setup,
    direction: card.direction,
    regime_label: card.regime.label,
    regime_tier: card.regime.tier,
    quality_score: card.quality_score,
    sample_confidence: card.sample_confidence,
    setup_sample_size: card.setup_sample_size,
    strategy_health: card.strategy_health,
    entry_price: card.entry_price,
    stop_price: card.exit.stop_price,
    target_price: card.exit.target_price,
    gross_r: card.expectancy.gross_r,
    cost_r: card.expectancy.cost_r,
    net_r: card.expectancy.net_r,
    position_size: card.position_size,
    risk_amount: card.risk_amount,
    risk_pct: card.risk_pct,
    currency: card.currency,
    correlation_cluster: card.correlation_cluster,
    gate_passed: gate.passed,
    gate_blocks: gate.blocks,
    card_json: card,
  };

  const { error } = await supabase
    .from('trading_proposals')
    .upsert(row, { onConflict: 'proposal_id' });
  if (error) throw error;
}

export async function saveDecision(rec: DecisionRecord): Promise<void> {
  const row = {
    proposal_id: rec.proposal_id,
    decided_at: iso(rec.decided_at),
    decision: rec.decision,
    outcome: rec.outcome,
    accepted: rec.accepted,
    reason_code: rec.reason_code,
    founder_thesis: rec.founder_thesis,
    resnooze_until: rec.resnooze_until != null ? iso(rec.resnooze_until) : null,
    gate_passed: rec.gate_passed,
    route_to_shadow: rec.route_to_shadow,
    error: rec.error,
    decision_json: rec,
  };

  const { error } = await supabase
    .from('trading_decisions')
    .upsert(row, { onConflict: 'proposal_id' });
  if (error) throw error;
}

export async function saveShadowResult(
  proposal_id: string,
  state: PositionState,
): Promise<void> {
  const row = {
    proposal_id,
    status: state.status,
    exit_reason: state.exit_reason,
    realised_r: state.realised_r,
    bars_held: state.bars_held,
    trail_activated: state.trail_active,
    max_favorable_excursion: state.max_favorable_excursion,
    max_adverse_excursion: state.max_adverse_excursion,
    would_have_won: state.realised_r != null && state.realised_r > 0,
    would_have_hit_target: state.status === 'target_hit',
    would_have_stopped: state.status === 'stopped',
    resolved_at: state.exit_bar_time != null ? iso(state.exit_bar_time) : null,
    state_json: state,
  };

  const { error } = await supabase
    .from('trading_shadow_results')
    .upsert(row, { onConflict: 'proposal_id' });
  if (error) throw error;
}
