/**
 * lib/decide.ts — The founder-decision reducer (Trading OS v3).
 *
 * Pure, synchronous, no I/O. Given a proposal, its risk-gate result, and the
 * founder's call, produce one immutable DecisionRecord. This is the audit trail
 * primitive: every proposal the founder sees resolves to exactly one record,
 * whether accepted or rejected.
 *
 * Design rules (mirrors risk-gate.ts / exit-stepper.ts):
 *  - NEVER throw. Problems are data (outcome + error), not exceptions.
 *  - No mutation of inputs.
 *  - The core discipline rule is non-negotiable: a card that FAILED the gate can
 *    never be approved, no matter how convincing the founder's thesis is.
 *  - Skipped + expired cards route to the Shadow Tracker — we phantom-trade the
 *    roads not taken so the system learns from omission, not just commission.
 */

import type { ProposalCard, RiskGateResult } from './proposal';

export type Decision = 'approve' | 'skip' | 'snooze';

export type SkipReason =
  | 'exposure_full'
  | 'macro_concern'
  | 'weak_conviction'
  | 'unclear_structure'
  | 'personal_override';

export interface DecisionInput {
  card: ProposalCard;
  gate: RiskGateResult; // result of validateProposalRisk on this card
  decision: Decision;
  reason_code?: SkipReason; // REQUIRED when decision === 'skip'
  founder_thesis?: string; // REQUIRED when decision === 'approve'
  snooze_minutes?: number; // optional, default 15, only for 'snooze'
  decided_at?: number; // epoch ms, default Date.now()
}

export type DecisionOutcome =
  | 'approved'
  | 'skipped'
  | 'snoozed'
  | 'rejected_gate_failed' // tried to approve a card that failed the gate
  | 'rejected_expired' // card already past expires_at at decision time
  | 'rejected_missing_reason' // skip without reason_code
  | 'rejected_missing_thesis'; // approve without (non-empty) founder_thesis

export interface DecisionRecord {
  proposal_id: string;
  symbol: string;
  decided_at: number;
  decision: Decision;
  outcome: DecisionOutcome;
  accepted: boolean; // true only if outcome in {approved,skipped,snoozed}
  reason_code: SkipReason | null;
  founder_thesis: string | null;
  resnooze_until: number | null; // decided_at + snooze_minutes*60000, else null
  gate_passed: boolean; // echo gate.passed for the audit trail
  route_to_shadow: boolean; // true for skipped + expired (phantom-trade these)
  error: string | null; // human-readable when outcome is a rejected_*
}

const DEFAULT_SNOOZE_MINUTES = 15;

export function decide(input: DecisionInput): DecisionRecord {
  const { card, gate, decision } = input;
  const decided_at = input.decided_at ?? Date.now();
  const trimmedThesis = input.founder_thesis?.trim() ?? '';

  // Shared base — every return path fills in the same audit fields.
  const base = {
    proposal_id: card.proposal_id,
    symbol: card.symbol,
    decided_at,
    decision,
    gate_passed: gate.passed,
  };

  const reject = (
    outcome: DecisionOutcome,
    error: string,
    route_to_shadow: boolean,
  ): DecisionRecord => ({
    ...base,
    outcome,
    accepted: false,
    reason_code: null,
    founder_thesis: null,
    resnooze_until: null,
    route_to_shadow,
    error,
  });

  // a. EXPIRY — beats everything. An expired card is a phantom skip.
  if (card.expires_at <= decided_at) {
    return reject(
      'rejected_expired',
      `Proposal expired at ${new Date(card.expires_at).toISOString()}; decided at ${new Date(decided_at).toISOString()}.`,
      true,
    );
  }

  // b. APPROVE guard 1 — the gate. A failed card can NEVER be approved, thesis
  //    or not. This is the core discipline rule.
  if (decision === 'approve' && gate.passed === false) {
    return reject(
      'rejected_gate_failed',
      `Cannot approve: risk gate failed with ${gate.blocks.length} block(s) [${gate.blocks.map((b) => b.code).join(', ')}].`,
      false,
    );
  }

  // c. APPROVE guard 2 — a real thesis is mandatory.
  if (decision === 'approve' && trimmedThesis === '') {
    return reject(
      'rejected_missing_thesis',
      'Cannot approve without a non-empty founder_thesis.',
      false,
    );
  }

  // d. SKIP guard — a skip must record WHY, for later pattern analysis.
  if (decision === 'skip' && input.reason_code == null) {
    return reject(
      'rejected_missing_reason',
      'Cannot skip without a reason_code.',
      false,
    );
  }

  // e. Accept.
  if (decision === 'approve') {
    return {
      ...base,
      outcome: 'approved',
      accepted: true,
      reason_code: null,
      founder_thesis: trimmedThesis,
      resnooze_until: null,
      route_to_shadow: false,
      error: null,
    };
  }

  if (decision === 'skip') {
    return {
      ...base,
      outcome: 'skipped',
      accepted: true,
      reason_code: input.reason_code ?? null,
      founder_thesis: null,
      resnooze_until: null,
      route_to_shadow: true,
      error: null,
    };
  }

  // snooze
  const minutes = input.snooze_minutes ?? DEFAULT_SNOOZE_MINUTES;
  return {
    ...base,
    outcome: 'snoozed',
    accepted: true,
    reason_code: null,
    founder_thesis: null,
    resnooze_until: decided_at + minutes * 60_000,
    route_to_shadow: false,
    error: null,
  };
}
