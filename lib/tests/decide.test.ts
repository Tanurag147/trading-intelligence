import { describe, it, expect } from 'vitest';
import { decide, type DecisionInput } from '../decide';
import { validateProposalRisk } from '../risk-gate';
import { cleanCard, cleanCtx } from './factory';

// Real passing gate result for a clean trend-pullback.
function passingGate() {
  return validateProposalRisk({ card: cleanCard(), ctx: cleanCtx() });
}

// Real FAILED gate result (quality below the floor).
function failingGate() {
  const card = cleanCard({ quality_score: 5 });
  return validateProposalRisk({ card, ctx: cleanCtx() });
}

describe('approve', () => {
  it('passing gate + thesis => approved, accepted, no shadow route', () => {
    const card = cleanCard();
    const r = decide({
      card,
      gate: validateProposalRisk({ card, ctx: cleanCtx() }),
      decision: 'approve',
      founder_thesis: 'Pullback to 20EMA, leading sector, defined risk.',
      decided_at: 1_000_000,
    });
    expect(r.outcome).toBe('approved');
    expect(r.accepted).toBe(true);
    expect(r.route_to_shadow).toBe(false);
    expect(r.founder_thesis).toBe('Pullback to 20EMA, leading sector, defined risk.');
    expect(r.reason_code).toBeNull();
    expect(r.gate_passed).toBe(true);
    expect(r.error).toBeNull();
  });

  it('trims the stored thesis at the boundary', () => {
    const card = cleanCard();
    const r = decide({
      card,
      gate: passingGate(),
      decision: 'approve',
      founder_thesis: '   clean trend continuation   ',
    });
    expect(r.outcome).toBe('approved');
    expect(r.founder_thesis).toBe('clean trend continuation');
  });

  it('passing gate WITHOUT thesis => rejected_missing_thesis', () => {
    const r = decide({ card: cleanCard(), gate: passingGate(), decision: 'approve' });
    expect(r.outcome).toBe('rejected_missing_thesis');
    expect(r.accepted).toBe(false);
    expect(r.founder_thesis).toBeNull();
    expect(r.error).toBeTruthy();
  });

  it('whitespace-only thesis => rejected_missing_thesis', () => {
    const r = decide({
      card: cleanCard(),
      gate: passingGate(),
      decision: 'approve',
      founder_thesis: '   \t  \n ',
    });
    expect(r.outcome).toBe('rejected_missing_thesis');
    expect(r.accepted).toBe(false);
  });

  it('FAILED gate => rejected_gate_failed EVEN WITH a thesis (discipline rule)', () => {
    const card = cleanCard({ quality_score: 5 });
    const gate = validateProposalRisk({ card, ctx: cleanCtx() });
    expect(gate.passed).toBe(false); // sanity: the gate really did fail
    const r = decide({
      card,
      gate,
      decision: 'approve',
      founder_thesis: 'I really believe in this one despite the score.',
    });
    expect(r.outcome).toBe('rejected_gate_failed');
    expect(r.accepted).toBe(false);
    expect(r.route_to_shadow).toBe(false);
    expect(r.founder_thesis).toBeNull(); // thesis is NOT stored on a rejection
    expect(r.gate_passed).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('skip', () => {
  it('with reason_code => skipped, routes to shadow, reason stored', () => {
    const r = decide({
      card: cleanCard(),
      gate: passingGate(),
      decision: 'skip',
      reason_code: 'weak_conviction',
    });
    expect(r.outcome).toBe('skipped');
    expect(r.accepted).toBe(true);
    expect(r.route_to_shadow).toBe(true);
    expect(r.reason_code).toBe('weak_conviction');
    expect(r.founder_thesis).toBeNull();
    expect(r.error).toBeNull();
  });

  it('WITHOUT reason_code => rejected_missing_reason', () => {
    const r = decide({ card: cleanCard(), gate: passingGate(), decision: 'skip' });
    expect(r.outcome).toBe('rejected_missing_reason');
    expect(r.accepted).toBe(false);
    expect(r.reason_code).toBeNull();
    expect(r.route_to_shadow).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('skip is allowed even on a FAILED gate (only approve is gate-locked)', () => {
    const r = decide({
      card: cleanCard({ quality_score: 5 }),
      gate: failingGate(),
      decision: 'skip',
      reason_code: 'unclear_structure',
    });
    expect(r.outcome).toBe('skipped');
    expect(r.accepted).toBe(true);
    expect(r.route_to_shadow).toBe(true);
  });
});

describe('snooze', () => {
  it('default => snoozed, resnooze_until == decided_at + 15min', () => {
    const decided_at = 1_700_000_000_000;
    const r = decide({ card: cleanCard(), gate: passingGate(), decision: 'snooze', decided_at });
    expect(r.outcome).toBe('snoozed');
    expect(r.accepted).toBe(true);
    expect(r.route_to_shadow).toBe(false);
    expect(r.resnooze_until).toBe(decided_at + 15 * 60_000);
  });

  it('snooze_minutes:30 => resnooze_until offset 30min', () => {
    const decided_at = 1_700_000_000_000;
    const r = decide({
      card: cleanCard(),
      gate: passingGate(),
      decision: 'snooze',
      snooze_minutes: 30,
      decided_at,
    });
    expect(r.resnooze_until).toBe(decided_at + 30 * 60_000);
  });
});

describe('expiry beats everything', () => {
  it('expired card => rejected_expired, routes to shadow', () => {
    const card = cleanCard({ expires_at: 500_000 });
    const r = decide({
      card,
      gate: passingGate(),
      decision: 'skip',
      reason_code: 'macro_concern',
      decided_at: 1_000_000,
    });
    expect(r.outcome).toBe('rejected_expired');
    expect(r.accepted).toBe(false);
    expect(r.route_to_shadow).toBe(true);
    expect(r.error).toBeTruthy();
  });

  it('expired + approve + no thesis => still rejected_expired (expiry wins)', () => {
    const card = cleanCard({ expires_at: 500_000 });
    const r = decide({
      card,
      gate: failingGate(), // even a failed gate is irrelevant — expiry is checked first
      decision: 'approve',
      decided_at: 1_000_000,
    });
    expect(r.outcome).toBe('rejected_expired');
    expect(r.accepted).toBe(false);
    expect(r.route_to_shadow).toBe(true);
  });
});

describe('accepted flag', () => {
  it('is true ONLY for approved / skipped / snoozed', () => {
    const card = cleanCard();
    const approved = decide({ card, gate: passingGate(), decision: 'approve', founder_thesis: 'x' });
    const skipped = decide({ card, gate: passingGate(), decision: 'skip', reason_code: 'exposure_full' });
    const snoozed = decide({ card, gate: passingGate(), decision: 'snooze' });
    const rejected = decide({ card, gate: passingGate(), decision: 'approve' }); // no thesis

    expect([approved.accepted, skipped.accepted, snoozed.accepted]).toEqual([true, true, true]);
    expect(rejected.accepted).toBe(false);
  });
});

describe('purity', () => {
  it('does not mutate the input object', () => {
    const card = cleanCard();
    const input: DecisionInput = {
      card,
      gate: passingGate(),
      decision: 'approve',
      founder_thesis: '   spaced thesis   ',
      decided_at: 1_234,
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    decide(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot); // untouched
    expect(input.founder_thesis).toBe('   spaced thesis   '); // not trimmed in place
  });
});
