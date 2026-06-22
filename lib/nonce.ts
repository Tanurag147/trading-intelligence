/**
 * lib/nonce.ts — Single-use callback nonce infrastructure for Telegram buttons.
 *
 * A nonce is an unguessable token bound to (proposal, action, telegram user).
 * Minted at card-send time (3 per proposal — one per action), burned on first
 * tap. The burn is a CONDITIONAL UPDATE (used_at IS NULL) so it is atomic and
 * single-use even under concurrent taps: only the caller whose UPDATE actually
 * touched a row wins.
 *
 * Reuses the existing supabase singleton Proxy. All functions are async and
 * throw on DB error per the repo convention (`const { error } = await ...;
 * if (error) throw error`).
 */

import { supabase } from './supabase';

type NonceAction = 'approve' | 'skip' | 'snooze';

const TABLE = 'trading_callback_nonces';

/**
 * Cryptographically random nonce, hex, 64 chars (32 bytes). Well above the
 * 32-char floor. Uses Web Crypto (available in the Vercel/Node runtime).
 */
function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function mintNonce(args: {
  proposal_id: string;
  action: NonceAction;
  telegram_user_id: string;
  expires_at: number; // epoch ms
}): Promise<string> {
  const nonce = randomNonce();
  const { error } = await supabase.from(TABLE).insert({
    nonce,
    proposal_id: args.proposal_id,
    action: args.action,
    telegram_user_id: args.telegram_user_id,
    expires_at: new Date(args.expires_at).toISOString(),
  });
  if (error) throw error;
  return nonce;
}

export type NonceCheck =
  | { ok: true; proposal_id: string; action: NonceAction }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'already_used' | 'user_mismatch';
    };

/**
 * Validate a tapped nonce and atomically burn it. Order of checks matters:
 * a non-matching action is treated as not_found so a valid nonce can't be
 * probed for its action. The burn is the lock — a conditional UPDATE on
 * used_at IS NULL; if it affects 0 rows, another tap already won.
 */
export async function verifyAndBurnNonce(args: {
  nonce: string;
  expected_action: string;
  telegram_user_id: string;
}): Promise<NonceCheck> {
  const { data: row, error } = await supabase
    .from(TABLE)
    .select('proposal_id, action, telegram_user_id, expires_at, used_at')
    .eq('nonce', args.nonce)
    .maybeSingle();
  if (error) throw error;

  if (!row) return { ok: false, reason: 'not_found' };
  if (row.telegram_user_id !== args.telegram_user_id) {
    return { ok: false, reason: 'user_mismatch' };
  }
  if (row.used_at != null) return { ok: false, reason: 'already_used' };
  if (Date.now() > new Date(row.expires_at).getTime()) {
    return { ok: false, reason: 'expired' };
  }
  // Action mismatch => behave as not_found (don't leak the real action).
  if (row.action !== args.expected_action) {
    return { ok: false, reason: 'not_found' };
  }

  // Atomic single-use burn: only succeeds if used_at is still NULL. Under
  // concurrent taps exactly one UPDATE touches the row; the rest match 0 rows.
  const { data: burned, error: burnError } = await supabase
    .from(TABLE)
    .update({ used_at: new Date().toISOString() })
    .eq('nonce', args.nonce)
    .is('used_at', null)
    .select('nonce');
  if (burnError) throw burnError;

  if (!burned || burned.length === 0) {
    return { ok: false, reason: 'already_used' };
  }

  return { ok: true, proposal_id: row.proposal_id, action: row.action as NonceAction };
}
