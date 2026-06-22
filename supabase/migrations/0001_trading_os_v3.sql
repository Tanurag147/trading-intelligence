-- 0001_trading_os_v3.sql — Trading OS v3 persistence layer.
--
-- Three NEW tables that sit BESIDE the existing trading_* tables. This migration
-- does NOT alter, drop, or reference any pre-v3 table. The only foreign keys here
-- point at the new trading_proposals table (proposal_id), never at legacy tables.
--
-- Conventions:
--  * Money/risk columns use plain names + a `currency` column (NO _aud suffix) so
--    USD equities and AUD crypto coexist in one schema.
--  * Decision-critical fields are typed columns FOR QUERYING, plus a *_json jsonb
--    column holding the full pure object FOR SHAPE-EVOLUTION.
--  * proposal_id is the idempotency key across all three tables.
--  * RLS matches the repo's existing pattern: enabled + one permissive ALL policy
--    (the service-role key bypasses RLS anyway).

CREATE TABLE trading_proposals (
  proposal_id         text PRIMARY KEY,           -- from the card, idempotency key
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  symbol              text NOT NULL,
  asset_class         text NOT NULL,
  setup               text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('long','short')),
  regime_label        text NOT NULL,
  regime_tier         smallint NOT NULL CHECK (regime_tier BETWEEN 1 AND 5),
  quality_score       smallint NOT NULL,
  sample_confidence   text NOT NULL,
  setup_sample_size   integer NOT NULL,
  strategy_health     text NOT NULL,
  entry_price         numeric(18,8) NOT NULL,
  stop_price          numeric(18,8) NOT NULL,
  target_price        numeric(18,8) NOT NULL,
  gross_r             numeric(8,3) NOT NULL,
  cost_r              numeric(8,3) NOT NULL,
  net_r               numeric(8,3) NOT NULL,
  position_size       numeric(20,8) NOT NULL,
  risk_amount         numeric(14,2) NOT NULL,
  risk_pct            numeric(6,4) NOT NULL,
  currency            text NOT NULL,
  correlation_cluster text NOT NULL,
  gate_passed         boolean NOT NULL,
  gate_blocks         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- RiskBlock[]
  card_json           jsonb NOT NULL,              -- full ProposalCard
  inserted_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trading_proposals_symbol_idx   ON trading_proposals(symbol);
CREATE INDEX trading_proposals_created_idx  ON trading_proposals(created_at);
CREATE INDEX trading_proposals_passed_idx   ON trading_proposals(gate_passed);

CREATE TABLE trading_decisions (
  proposal_id      text PRIMARY KEY REFERENCES trading_proposals(proposal_id),
  decided_at       timestamptz NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('approve','skip','snooze')),
  outcome          text NOT NULL,
  accepted         boolean NOT NULL,
  reason_code      text,
  founder_thesis   text,
  resnooze_until   timestamptz,
  gate_passed      boolean NOT NULL,
  route_to_shadow  boolean NOT NULL,
  error            text,
  decision_json    jsonb NOT NULL,                -- full DecisionRecord
  inserted_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trading_decisions_outcome_idx ON trading_decisions(outcome);
CREATE INDEX trading_decisions_shadow_idx  ON trading_decisions(route_to_shadow);

CREATE TABLE trading_shadow_results (
  proposal_id             text PRIMARY KEY REFERENCES trading_proposals(proposal_id),
  status                  text NOT NULL,            -- PositionStatus
  exit_reason             text,                     -- PositionStatus | null
  realised_r              numeric(8,3),             -- null if degenerate
  bars_held               integer NOT NULL,
  trail_activated         boolean NOT NULL,
  max_favorable_excursion numeric(18,8) NOT NULL,
  max_adverse_excursion   numeric(18,8) NOT NULL,
  would_have_won          boolean,                  -- realised_r > 0
  would_have_hit_target   boolean,                  -- status = 'target_hit'
  would_have_stopped      boolean,                  -- status = 'stopped'
  resolved_at             timestamptz,              -- exit_bar_time, null if still open
  state_json              jsonb NOT NULL,           -- full PositionState
  inserted_at             timestamptz NOT NULL DEFAULT now()
);

-- RLS: enabled + permissive ALL policy, one per table (matches legacy pattern).
ALTER TABLE trading_proposals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_decisions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_shadow_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY trading_proposals_all      ON trading_proposals      FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY trading_decisions_all      ON trading_decisions      FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY trading_shadow_results_all ON trading_shadow_results FOR ALL TO public USING (true) WITH CHECK (true);
