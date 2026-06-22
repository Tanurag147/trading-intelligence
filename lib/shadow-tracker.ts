/**
 * lib/shadow-tracker.ts — The Shadow Tracker worker (Trading OS v3).
 *
 * Consumes proposals the founder routed to shadow (route_to_shadow=true — every
 * skipped or expired card) and phantom-trades them through the EXISTING exit
 * stepper, then persists the "would_have_*" verdict to trading_shadow_results.
 * The system thereby learns from the roads not taken, not just the trades it took.
 *
 * This module is pure orchestration + I/O glue:
 *  - No new exit logic. resolveShadow is a thin wrapper over runToCompletion.
 *  - No new persistence mapping. It calls saveShadowResult (upsert on proposal_id).
 *  - No market feed. Forward bars are injected via barsFor (a FixtureFeed for now);
 *    swapping in a real feed later is a caller change, not a change here.
 *
 * Idempotent: a still-open shadow (bars ran out before it resolved) is written as
 * status 'open' and re-picked on the next run; saveShadowResult upserts, so a
 * later run with more bars simply overwrites it with the newer verdict.
 */

import { supabase } from './supabase';
import { runToCompletion, type PositionState } from './exit-stepper';
import { saveShadowResult } from './persist';
import type { ProposalCard } from './proposal';
import type { MarketFeed, Bar } from './feed';

/**
 * Proposals that need a shadow verdict: routed to shadow AND not yet resolved
 * (no shadow row at all, OR a row still sitting at status 'open'). Throws on db
 * error per the repo convention.
 */
export async function findUnresolvedShadows(): Promise<
  Array<{ proposal_id: string; card: ProposalCard }>
> {
  // 1. Candidates: every decision the founder routed to shadow.
  const { data: decisions, error: dErr } = await supabase
    .from('trading_decisions')
    .select('proposal_id')
    .eq('route_to_shadow', true);
  if (dErr) throw dErr;

  const candidateIds = (decisions ?? []).map((d) => d.proposal_id as string);
  if (candidateIds.length === 0) return [];

  // 2. Already-resolved shadows: a row that has CLOSED (status !== 'open'). A
  //    missing row OR an 'open' row both mean "still needs work", so the
  //    anti-join is candidates minus the set of closed shadow rows.
  const { data: resolved, error: rErr } = await supabase
    .from('trading_shadow_results')
    .select('proposal_id')
    .neq('status', 'open');
  if (rErr) throw rErr;

  const resolvedIds = new Set((resolved ?? []).map((r) => r.proposal_id as string));
  const unresolvedIds = candidateIds.filter((id) => !resolvedIds.has(id));
  if (unresolvedIds.length === 0) return [];

  // 3. Load each unresolved proposal's full card (card_json holds the ProposalCard).
  const { data: proposals, error: pErr } = await supabase
    .from('trading_proposals')
    .select('proposal_id, card_json')
    .in('proposal_id', unresolvedIds);
  if (pErr) throw pErr;

  return (proposals ?? []).map((p) => ({
    proposal_id: p.proposal_id as string,
    card: p.card_json as ProposalCard,
  }));
}

/**
 * Phantom-trade a card through its own ExitPlan over the given forward bars.
 * PURE — delegates entirely to the existing exit stepper; no new exit logic.
 * The returned PositionState carries status, realised_r, MFE/MAE and bars_held,
 * from which saveShadowResult derives would_have_won / _hit_target / _stopped.
 */
export function resolveShadow(card: ProposalCard, bars: Bar[]): PositionState {
  return runToCompletion(card, bars, card.exit);
}

export interface ShadowTrackerArgs {
  /** Injected market feed (FixtureFeed in the paper phase). Reserved for callers
   *  whose barsFor reads through it; runShadowTracker itself only uses barsFor. */
  feed: MarketFeed;
  /** How to fetch post-entry forward bars for a card. */
  barsFor: (card: ProposalCard) => Promise<Bar[]>;
}

export interface ShadowTrackerSummary {
  scanned: number;
  resolved: number;
  still_open: number;
  /** Per-shadow failures (bad bars / write error) — collected, never fatal. */
  failures: Array<{ proposal_id: string; error: string }>;
}

/**
 * Scan unresolved shadows, phantom-trade each, and persist the verdict. A
 * per-shadow failure (bad bars, write error) is logged and collected — it does
 * not abort the run. A hard db error from findUnresolvedShadows DOES throw.
 */
export async function runShadowTracker(
  args: ShadowTrackerArgs,
): Promise<ShadowTrackerSummary> {
  const shadows = await findUnresolvedShadows();

  let resolved = 0;
  let still_open = 0;
  const failures: ShadowTrackerSummary['failures'] = [];

  for (const { proposal_id, card } of shadows) {
    try {
      const bars = await args.barsFor(card);
      const state = resolveShadow(card, bars);
      await saveShadowResult(proposal_id, state);
      if (state.status !== 'open') resolved += 1;
      else still_open += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('shadow resolve failed', JSON.stringify({ proposal_id, error: message }));
      failures.push({ proposal_id, error: message });
    }
  }

  return { scanned: shadows.length, resolved, still_open, failures };
}
