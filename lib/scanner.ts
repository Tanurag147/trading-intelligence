/**
 * lib/scanner.ts — The Scanner Engine.
 *
 * A scheduled sweep that, during US-equity market hours, walks a fixed watchlist
 * and AUTO-SENDS a Telegram proposal card for every symbol whose proposal clears
 * the existing risk gate — with hard anti-spam guardrails.
 *
 * REUSE, not reimplementation: per symbol we call the SAME pipeline the manual
 * `trading:propose` command uses —
 *   buildRealProposalInput (real bars → regime → ATR geometry, AlpacaFeed)
 *   → buildProposal (assemble card)  → validateProposalRisk (the gate)
 *   → saveProposal (persist every proposal)  → mintNonce + sendProposalCard (PASS only).
 * The gate / engine / nonce / persist / regime / feed internals are untouched.
 *
 * The one behavioural difference from runProposal: this is an UNSOLICITED auto-push,
 * so it must be SILENT on anything the founder didn't ask for. A gate-blocked or
 * cooled-down or capped symbol is recorded for the audit trail but NEVER messaged.
 * Block reasons are only shown on the manual `trading:propose`. The ONLY thing the
 * scanner ever sends is a PASSING card with live approve/skip/snooze buttons.
 *
 * Two guardrails, both backed by trading_scan_alerts (only outcome='sent' counts):
 *   - COOLDOWN  — no second alert for the same symbol within cooldown_hours.
 *   - DAILY CAP — no more than max_alerts_per_day alerts across ALL symbols, and
 *                 the cap is re-checked every iteration (canAlert reads the live
 *                 count, which already includes sends made earlier in this run),
 *                 so a single scan can never blow past the cap.
 *
 * KNOWN GAP: no market-holiday calendar yet. isMarketHours only knows weekends +
 * the regular-session clock, so the scanner WILL run on a US holiday. That's safe:
 * it simply finds stale bars / no fresh trending setups and sends nothing.
 */

import { supabase } from './supabase';
import { buildProposal } from './build-proposal';
import { validateProposalRisk } from './risk-gate';
import { saveProposal } from './persist';
import { mintNonce } from './nonce';
import { sendProposalCard, type ProposalAction } from './telegram';
import { buildRealProposalInput } from './propose';
import { AlpacaFeed } from './feeds/alpaca';
import type { Quote } from './feed';

/** The ten Phase 1 symbols the scanner watches (US equities + the two index ETFs). */
export const WATCHLIST: readonly string[] = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'SPY', 'QQQ',
];

/** Anti-spam configuration. */
export const SCAN_LIMITS = {
  cooldown_hours: 4,
  max_alerts_per_day: 5,
} as const;

/** ~300ms between per-symbol feed calls to respect Alpaca rate limits. */
const SLEEP_MS = 300;

/** Outcomes persisted to trading_scan_alerts (only 'sent' counts toward limits). */
export type AlertOutcome = 'sent' | 'cooldown' | 'daily_cap' | 'blocked' | 'error';

/** Per-symbol outcome reported by runScan (superset — 'market_closed' never persists). */
export type ScanOutcome = AlertOutcome | 'market_closed';

export interface ScanDetail {
  symbol: string;
  outcome: ScanOutcome;
  proposal_id?: string;
}

export interface ScanSummary {
  scanned: number;
  sent: number;
  skipped: Record<string, number>;
  details: ScanDetail[];
}

export interface RunScanArgs {
  chatId: string;
  telegram_user_id: string;
  /** Injectable clock — defaults to wall-clock. Drives market-hours + limits. */
  now?: Date;
  /** Per-symbol delay (ms). Defaults to SLEEP_MS; set 0 in tests. */
  sleepMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** UTC calendar date (YYYY-MM-DD) for `scan_date` bucketing — matches the column default. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Is `now` inside the US-equity regular session (Mon–Fri, 09:30–16:00 ET)?
 *
 * Computed in America/New_York via Intl, so DST is handled automatically — the
 * same UTC instant maps to EDT (summer) or EST (winter) without any offset math.
 * Weekends and any time outside the session return false. (No holiday calendar
 * yet — see the file header; running on a holiday is harmless.)
 */
export function isMarketHours(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  const hourRaw = get('hour');
  const minuteRaw = get('minute');
  if (!weekday || hourRaw === undefined || minuteRaw === undefined) return false;

  if (weekday === 'Sat' || weekday === 'Sun') return false;

  // hour12:false can render midnight as '24' in some ICU builds — normalise.
  let hour = Number(hourRaw);
  if (hour === 24) hour = 0;
  const minutes = hour * 60 + Number(minuteRaw);

  const open = 9 * 60 + 30; // 09:30
  const close = 16 * 60; //    16:00
  return minutes >= open && minutes <= close;
}

/**
 * May we auto-alert `symbol` right now? Checks the two guardrails against
 * trading_scan_alerts, counting ONLY outcome='sent' rows. Cooldown (per-symbol)
 * is checked before the daily cap (global).
 */
export async function canAlert(
  symbol: string,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: 'cooldown' | 'daily_cap' }> {
  // COOLDOWN — any 'sent' alert for this symbol within the last cooldown_hours.
  const since = new Date(now.getTime() - SCAN_LIMITS.cooldown_hours * 3_600_000).toISOString();
  const cooldownRes = await supabase
    .from('trading_scan_alerts')
    .select('id')
    .eq('symbol', symbol)
    .eq('outcome', 'sent')
    .gte('alerted_at', since)
    .limit(1);
  if (cooldownRes.error) throw cooldownRes.error;
  if (cooldownRes.data && cooldownRes.data.length > 0) {
    return { ok: false, reason: 'cooldown' };
  }

  // DAILY CAP — count today's 'sent' alerts across ALL symbols.
  const capRes = await supabase
    .from('trading_scan_alerts')
    .select('id', { count: 'exact', head: true })
    .eq('outcome', 'sent')
    .eq('scan_date', utcDate(now));
  if (capRes.error) throw capRes.error;
  if ((capRes.count ?? 0) >= SCAN_LIMITS.max_alerts_per_day) {
    return { ok: false, reason: 'daily_cap' };
  }

  return { ok: true };
}

/** Record one scan decision. alerted_at/scan_date are set from `now` for a consistent run. */
export async function recordAlert(
  symbol: string,
  proposal_id: string | null,
  outcome: AlertOutcome,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await supabase.from('trading_scan_alerts').insert({
    symbol,
    proposal_id,
    outcome,
    alerted_at: now.toISOString(),
    scan_date: utcDate(now),
  });
  if (error) throw error;
}

/**
 * Scan the watchlist and auto-send a card for every PASSING, non-throttled symbol.
 *
 * Outside market hours this returns early WITHOUT alerting (the schedule guard:
 * the cron may fire on the DST buffer minutes / a holiday, and we don't want to
 * push then). Inside hours it instantiates ONE AlpacaFeed and reuses it across
 * symbols, sleeping briefly between each to respect rate limits.
 */
export async function runScan(args: RunScanArgs): Promise<ScanSummary> {
  const now = args.now ?? new Date();
  const sleepMs = args.sleepMs ?? SLEEP_MS;

  if (!isMarketHours(now)) {
    return { scanned: 0, sent: 0, skipped: { market_closed: 1 }, details: [] };
  }

  // ONE feed instance, reused for every symbol (buildRealProposalInput uses it).
  const feed = new AlpacaFeed();

  const details: ScanDetail[] = [];
  const skipped: Record<string, number> = {};
  let sent = 0;
  const bump = (key: string) => {
    skipped[key] = (skipped[key] ?? 0) + 1;
  };

  for (let i = 0; i < WATCHLIST.length; i++) {
    if (i > 0 && sleepMs > 0) await sleep(sleepMs);
    const symbol = WATCHLIST[i];

    try {
      // (a) Guardrails first — a cooldown/cap skip is SILENT (no Telegram).
      const gate0 = await canAlert(symbol, now);
      if (!gate0.ok) {
        await recordAlert(symbol, null, gate0.reason, now);
        bump(gate0.reason);
        details.push({ symbol, outcome: gate0.reason });
        continue;
      }

      // (b) Build + gate via the existing pipeline, WITHOUT sending yet. We need
      //     pass/fail before deciding whether this is worth an unsolicited push.
      //     buildRealProposalInput already fetched the real entry price; reuse it
      //     (buildProposal reads entry_price, not the quote) to avoid a 2nd call.
      const built = await buildRealProposalInput(symbol, args.chatId, args.telegram_user_id, feed);
      const quote: Quote = { symbol, price: built.build.entry_price, asOf: now.getTime() };
      const card = buildProposal({ ...built.build, symbol, quote });
      const gate = validateProposalRisk({ card, ctx: built.ctx, limits: built.limits });

      // Persist EVERY proposal (passed or not), same as runProposal.
      await saveProposal(card, gate);

      // (c) Gate FAILED → record silently, send NOTHING. Auto-scan never spams
      //     block reasons; blocks are only surfaced on manual trading:propose.
      if (!gate.passed) {
        await recordAlert(symbol, card.proposal_id, 'blocked', now);
        bump('blocked');
        details.push({ symbol, outcome: 'blocked', proposal_id: card.proposal_id });
        continue;
      }

      // (d) Gate PASSED → mint 3 single-use nonces and send the card with buttons,
      //     reusing runProposal's exact send path. Then record 'sent'.
      const actions: ProposalAction[] = ['approve', 'skip', 'snooze'];
      const [approve, skip, snooze] = await Promise.all(
        actions.map((action) =>
          mintNonce({
            proposal_id: card.proposal_id,
            action,
            telegram_user_id: args.telegram_user_id,
            expires_at: card.expires_at,
          }),
        ),
      );
      await sendProposalCard(args.chatId, card, { approve, skip, snooze });
      await recordAlert(symbol, card.proposal_id, 'sent', now);
      sent += 1;
      details.push({ symbol, outcome: 'sent', proposal_id: card.proposal_id });
    } catch (err) {
      // Per-symbol failure never sinks the whole scan. Record + move on, SILENT.
      console.error('scan symbol failed', JSON.stringify({ symbol, error: (err as Error).message }));
      try {
        await recordAlert(symbol, null, 'error', now);
      } catch (recErr) {
        console.error('scan recordAlert(error) failed', JSON.stringify({ symbol, error: (recErr as Error).message }));
      }
      bump('error');
      details.push({ symbol, outcome: 'error' });
    }
  }

  return { scanned: WATCHLIST.length, sent, skipped, details };
}
