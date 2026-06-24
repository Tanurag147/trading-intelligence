-- 0003_scanner_state.sql — Anti-spam state for the Scanner Engine.
--
-- The scanner runs on a schedule during US market hours, walks a watchlist, and
-- auto-sends a Telegram proposal card for any symbol whose proposal PASSES the
-- existing risk gate. This table is the memory that keeps it from spamming:
--
--   * COOLDOWN  — at most one auto-alert per symbol per `cooldown_hours`.
--   * DAILY CAP — at most `max_alerts_per_day` auto-alerts across ALL symbols.
--
-- Every scan decision is recorded (sent / cooldown / daily_cap / blocked / error)
-- for an audit trail, but ONLY rows with outcome='sent' count toward the cooldown
-- and the daily cap. A gate-blocked or cooled-down symbol is recorded silently
-- and never messaged (the key anti-spam rule).
--
-- Conventions match the rest of the trading_ layer: RLS enabled + one permissive
-- ALL policy (the service-role key bypasses RLS anyway). This migration does NOT
-- alter, drop, or reference any other table.

CREATE TABLE trading_scan_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        text NOT NULL,
  proposal_id   text,                              -- the proposal sent (if any)
  alerted_at    timestamptz NOT NULL DEFAULT now(),
  scan_date     date NOT NULL DEFAULT (now() at time zone 'UTC')::date,
  outcome       text NOT NULL                      -- 'sent' | 'cooldown' | 'daily_cap' | 'blocked' | 'error'
);
CREATE INDEX trading_scan_alerts_symbol_idx ON trading_scan_alerts(symbol, alerted_at);
CREATE INDEX trading_scan_alerts_date_idx   ON trading_scan_alerts(scan_date);

ALTER TABLE trading_scan_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY trading_scan_alerts_all ON trading_scan_alerts
  FOR ALL TO public USING (true) WITH CHECK (true);
-- only rows with outcome='sent' count toward cooldown + daily cap.
