-- 0002_callback_nonces.sql — Single-use callback nonces for Telegram buttons.
--
-- PREREQUISITE for approve/skip/snooze inline buttons. A nonce is an
-- unguessable, single-use token bound to (proposal, action, telegram user).
-- It is minted at card-send time (3 per proposal — one per action) and burned
-- on the first tap. The burn is a CONDITIONAL UPDATE (used_at IS NULL) so it is
-- atomic and single-use even under concurrent taps.
--
-- Conventions match the rest of the v3 layer:
--  * FK points only at the new trading_proposals table, never legacy tables.
--  * RLS enabled + one permissive ALL policy (service-role key bypasses RLS).
--  * This migration does NOT alter, drop, or reference any pre-v3 table.

CREATE TABLE trading_callback_nonces (
  nonce            text PRIMARY KEY,                 -- random 32+ char
  proposal_id      text NOT NULL REFERENCES trading_proposals(proposal_id),
  action           text NOT NULL CHECK (action IN ('approve','skip','snooze')),
  telegram_user_id text NOT NULL,                    -- who is allowed to use it
  expires_at       timestamptz NOT NULL,             -- = proposal expires_at
  used_at          timestamptz,                      -- null until burned; single-use
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trading_callback_nonces_proposal_idx ON trading_callback_nonces(proposal_id);

ALTER TABLE trading_callback_nonces ENABLE ROW LEVEL SECURITY;
CREATE POLICY trading_callback_nonces_all ON trading_callback_nonces
  FOR ALL TO public USING (true) WITH CHECK (true);
