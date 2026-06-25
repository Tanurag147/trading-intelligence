# TRADING OS v3 — Canonical Spec

> Status legend: **BUILT** = implemented and wired · **PARTIAL** = logic exists but fed placeholder/static data, or only some sub-parts done · **NOT-BUILT** = specified here, absent in code.
> This is a layered design contract: it documents what the repo actually contains (with file citations) and explicitly flags what is specified-but-not-yet-built. An aspiration is never written as if it exists. Last grounded against the code on 2026-06-25.

> **STATUS HONESTY.** v3's core engine modules (regime, cost, exit) are built and the risk gate is fully coded — but several of them currently operate on **placeholder or static inputs**: portfolio context is a clean always-passing stub, cost is one fixed constant, data freshness is hardcoded as OK, and the regime cron still serves the wrong asset class. As a result, **the risk gate is NOT yet enforcing against live state** — its open-risk, cluster, drawdown, cadence, blackout, earnings, and data-integrity checks exist but do not fire against reality. Read "engine BUILT" in this spec as "the logic exists and is wired," NOT as "the engine is live and enforcing." The §7 SAFETY-CRITICAL gaps are what stand between built and enforcing.

---

## 1. PURPOSE & SCOPE

Trading OS v3 is a **semi-automated discretionary swing-trading intelligence layer** for **US equities** (10-symbol Phase 1 universe). It builds risk-validated trade proposals from real market data and pushes them to the founder as **Telegram proposal cards**. The founder decides **Approve / Skip / Snooze**; the system never places orders. Skipped/expired proposals are phantom-traded by a Shadow Tracker so the system learns from the roads not taken.

Scope boundary: this is an **intelligence layer, not an execution layer**. It informs and enforces discipline; the founder places every real order by hand.

---

## 2. HARD RULES (the design contract's spine)

These mirror `CLAUDE.md` HARD BOUNDARIES and are non-negotiable:

1. **No autonomous execution.** The only founder interface is Approve/Skip/Snooze on a Telegram card. No code path places orders. *(BUILT — `decide.ts`, `app/api/telegram/route.ts`; no broker integration exists anywhere.)*
2. **A failed-gate card can NEVER be approved.** No override, no thesis, no exception. *(BUILT — `decide.ts:105` returns `rejected_gate_failed`; failed cards are sent with NO buttons, `propose.ts:91`.)*
3. **Filter-stability is absolute.** Rules are not relaxable at decision time. The gate is pure and re-derives geometry independently of the card's claims. *(BUILT — `risk-gate.ts` is pure, fail-closed, collects ALL blocks.)*
4. **The four Phase 1 engines — regime, correlation, cost, exit — are mandatory.** See §4 for per-engine build status.
5. **Cost modeling and exit discipline are mandatory Phase 1, never deferred.** *(Cost: BUILT as net-expectancy gate; Exit: BUILT as bar-by-bar stepper. See §4.)*
6. **Fail closed.** Any ambiguity (stale data, bad geometry, integrity off) blocks. *(BUILT — `risk-gate.ts:59-70`; `AlpacaFeed` throws on non-200 and on zero price.)*

---

## 3. ARCHITECTURE (as actually built)

**Data flow (proposal path):**
```
MarketFeed (AlpacaFeed)                          lib/feeds/alpaca.ts
  → buildRealProposalInput  (bars→regime→ATR geometry→quality)   lib/propose.ts
    → regime engine          calculateRegime                     lib/regime.ts
    → quality engine         scoreQuality                        lib/quality.ts
    → buildProposal          (assemble ProposalCard + expectancy) lib/build-proposal.ts
      → validateProposalRisk (the gate)                          lib/risk-gate.ts
        → saveProposal       (persist EVERY proposal)            lib/persist.ts
          → mintNonce + sendProposalCard  (PASS only, w/ buttons) lib/nonce.ts, lib/telegram.ts
```

**Decision path (button tap → webhook):**
```
Telegram callback v3:<action>:<proposal_id>      app/api/telegram/route.ts
  → resolveAndBurnCallback (single-use nonce)    lib/propose.ts, lib/nonce.ts
    → loadProposalForCallback (rehydrate card+gate) lib/propose.ts
      → decide()              (immutable DecisionRecord)         lib/decide.ts
        → saveDecision        → trading_decisions               lib/persist.ts
          → editMessageText   (lock the card to its outcome)     lib/telegram.ts
```

**Shadow path:**
```
trading_decisions where route_to_shadow=true     lib/shadow-tracker.ts
  → findUnresolvedShadows (anti-join vs closed shadow rows)
    → resolveShadow → runToCompletion (exit stepper)            lib/exit-stepper.ts
      → saveShadowResult → trading_shadow_results               lib/persist.ts
```

**Key interface contracts (the seams):**
- `MarketFeed` (`lib/feed.ts`): `assetClass`, `getBars(symbol, '1d'|'4h', lookback)`, `getQuote(symbol)`. Bars oldest-first; methods throw → callers fail closed to "NO PROPOSAL".
- `ProposalCard` (`lib/proposal.ts`): the self-contained object the founder sees — regime view, quality, exit plan, expectancy, sizing, correlation cluster.
- `RiskGateResult` (`lib/proposal.ts`): `passed` + every `RiskBlock`. The card persists `gate_passed` + `gate_blocks`.
- `DecisionRecord` (`lib/decide.ts`): one immutable record per proposal; `route_to_shadow=true` for skipped+expired.
- Build vs gate are **separate concerns**: `buildProposal` never validates; a freshly built card may fail the gate (by design).
- Decoupling: `build-proposal.ts` never imports `regime.ts`; it takes a structural mirror (`RegimeInput`).

---

## 4. THE FOUR PHASE 1 ENGINES

### 4.1 Regime — **BUILT** (with limits)
- **Must do:** classify each symbol's daily regime and gate trades to healthy trends only.
- **Built:** `lib/regime.ts` `calculateRegime` computes ADX(14), EMA(20), ATR-ratio via Wilder smoothing from ≥28 daily candles; emits `trending_up | trending_down | ranging | volatile`. Mapped to a 1–5 tier in `build-proposal.ts mapRegimeToTier`; the gate allows only tiers **[4,5]** (`DEFAULT_LIMITS.allowed_regime_tiers`).
- **Limits to know:** the mapper can only ever emit **tier 4** for a tradeable name — **tier 5 (expansion) is never produced** (`mapRegimeToTier`: `trending_up→4`, `volatile/ranging→3`, `trending_down→2`). Long-only in validation phase. Only the `1d` timeframe is wired.

### 4.2 Correlation — **PARTIAL**
- **Must do:** prevent stacking correlated risk; cap total risk per correlation cluster.
- **Built:** static cluster taxonomy (`propose.ts CLUSTER_BY_SYMBOL`: `megacap_tech`, `ai_cluster`, `etf_cluster`); the gate enforces `max_cluster_risk_pct` (0.015) against `ctx.cluster_risk_pct + card.risk_pct` (`risk-gate.ts:126`).
- **NOT built:** the **live cluster-risk input is a placeholder** — `cluster_risk_pct` is hardcoded (`0` / `0.005`) in `buildRealProposalInput`/fixture, not computed from open positions. There is **no actual correlation measurement** (no correlation coefficients, no dynamic clustering) — clusters are a hand-maintained lookup. So the cap *logic* is real but it never sees real cluster exposure.

### 4.3 Cost — **BUILT** (static inputs)
- **Must do:** judge edge on **net** expectancy after costs, never gross.
- **Built:** `build-proposal.ts computeExpectancy` derives `net_r = gross_r − cost_r` from a `CostModel` (entry/stop/fast-exit slippage, fee, spread), pessimistic by construction (worst-case fast-exit slippage assumed). The gate blocks `net_expectancy_below_min` (`min_net_expectancy_r = 0.25`).
- **Caveat:** cost **inputs** are a single fixed constant `FIXTURE_COSTS` used for BOTH fixture and real proposals (`propose.ts:130`, used in `buildRealProposalInput`). Not per-symbol or live-calibrated. The model and gate are real; the numbers are static estimates.

### 4.4 Exit — **BUILT**
- **Must do:** every proposal carries a complete exit plan; exits are simulated deterministically.
- **Built:** `ExitPlan` on every card (stop, target, `trail_activate_r`, `time_stop_days`, `thesis_invalidation`). `exit-stepper.ts` runs pure bar-by-bar: per-bar priority **thesis > stop > target > time**; stop checked before target within a bar (pessimistic, since OHLC hides intrabar path); trail moves stop to breakeven at +1R; R always measured against the **original** plan stop. Drives both live-intent and shadow phantom trades identically.
- **Note:** there is no live position/exit *management* for v3 equities (no live orders by design — intelligence layer). The exit logic is used today by the Shadow Tracker.

---

## 5. DATA MODEL (the v3 `trading_*` tables)

All in `public` schema, project `wjfsiyxqxyollbcuzjsv` (SHARED DB). Created by `supabase/migrations/0001–0003`. `proposal_id` is the idempotency key across the first three; all writes are upserts.

| Table | Migration | Holds |
|---|---|---|
| `trading_proposals` | 0001 | Every proposal (passed or not): typed columns for querying + `card_json` (full ProposalCard), `gate_passed`, `gate_blocks` (RiskBlock[]). PK `proposal_id`. |
| `trading_decisions` | 0001 | One row per decided proposal: `decision`, `outcome`, `accepted`, `reason_code`, `founder_thesis`, `resnooze_until`, `route_to_shadow`, `decision_json`. FK→`trading_proposals`. |
| `trading_shadow_results` | 0001 | Phantom verdict: `status`, `realised_r`, `bars_held`, MFE/MAE, `would_have_won/_hit_target/_stopped`, `state_json`. FK→`trading_proposals`. |
| `trading_callback_nonces` | 0002 | Single-use Telegram button tokens: `nonce` (PK), `proposal_id`, `action`, `telegram_user_id`, `expires_at`, `used_at`. |
| `trading_scan_alerts` | 0003 | Scanner audit/anti-spam: `symbol`, `proposal_id`, `outcome` (sent/cooldown/daily_cap/blocked/error), `alerted_at`, `scan_date`. Only `outcome='sent'` counts toward limits. |

**Pre-v3 (crypto-era) tables still present and still read by some commands:** `trading_regime`, `trading_open_positions` (see §7 GAPS). v3 migrations explicitly do NOT alter legacy tables.

**RLS:** every v3 table has RLS enabled with ONE permissive policy `FOR ALL TO public USING (true) WITH CHECK (true)` (`0001:89-91`). Security rests entirely on **service-role-only access** (the anon key is never used for these), not on row policies — relevant on a shared DB.

---

## 6. INTERFACES

### 6.1 Telegram contract
- **Inbound webhook:** `POST /api/telegram` (`app/api/telegram/route.ts`). Verifies the `x-telegram-bot-api-secret-token` header against `TELEGRAM_WEBHOOK_SECRET` BEFORE parsing the body; if the env var is unset the guard is disabled (dev convenience) — **must be set in every deployed env**.
- **Proposal card buttons:** `callback_data = v3:<action>:<proposal_id>` where action ∈ {approve, skip, snooze} (`telegram.ts:128`). The 64-hex nonce is too long for Telegram's 64-byte cap, so the button carries `proposal_id` and the nonce is looked up server-side by `(proposal_id, action)` and burned.
- **Nonces:** 32-byte hex, one per (proposal, action), minted at send (`nonce.ts`); `verifyAndBurnNonce` is an atomic conditional UPDATE on `used_at IS NULL` (single-use under concurrent taps); bound to `telegram_user_id`; expires with the card (~15 min).
- **Card rendering:** HTML parse mode with full `escapeHtml` on all interpolated values (avoids the legacy Markdown stray-entity 400). On decision, the card is rewritten via `editMessageText` and its keyboard stripped.
- **Text commands:** `trading:regime|size|positions|brief|propose|scan|shadows|help` (`route.ts:112`).

### 6.2 Alpaca feed contract
- `AlpacaFeed` (`lib/feeds/alpaca.ts`), `assetClass = 'us_equity'`, free/basic IEX tier.
- **Bars:** over-fetch by calendar window (`max(lookback*2, 130)` days), page to exhaustion, sort ascending, return most recent `lookback`. Never a hardcoded bar count. Only `1Day` mapped; `4h` throws.
- **Quote:** prefers **latest trade** price (immune to after-hours zero-ask); falls back to quote bid/mid; **throws if no positive price** (fail-closed — a 0 entry corrupts sizing+R). `prevClose` from the prior daily bar (optional).
- **Auth:** `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` headers from env; non-200 throws; 401 (auth) vs 403 (tier) distinguished.

### 6.3 Cron contract
- Both crons require `Authorization: Bearer <CRON_SECRET>` → 401 otherwise.
- `GET /api/cron/scan` — runs `runScan` over the watchlist; market-hours-guarded; sends only PASSING cards; silent on blocks/cooldowns/caps. Recipient fixed by env (`TELEGRAM_TRADING_CHAT_ID` + `SCAN_OWNER_TELEGRAM_ID`).
- `GET /api/cron/regime` — **⚠️ still the crypto-era job** (see §7).
- **Schedules** (`vercel.json`): scan `*/15 13-21 * * 1-5` (every 15 min, US session, Mon–Fri — **15-min granularity requires Vercel Pro**; on Hobby, trigger from n8n with the Bearer header); regime `30 21 * * *` (daily).

---

## 7. GAPS / NOT-YET-BUILT (the honest contract)

The single most important section. Everything below is specified or implied above but the code does **not** yet satisfy it.

1. **[SAFETY-CRITICAL] Live portfolio context is entirely placeholder.** `buildRealProposalInput` feeds the gate a clean, always-passing `PortfolioContext` (`total_open_risk_pct`, `cluster_risk_pct`, `trades_this_week`, `consecutive_losses`, `current_drawdown_pct` all 0; `data_integrity_ok=true`; blackout/earnings `false`) — `propose.ts:399`. **Consequence:** the gate's total-open-risk, cluster-risk, weekly-cap, consecutive-loss-halt, drawdown, macro-blackout, and earnings-in-window checks exist but **never fire against reality**. This is the biggest gap.
2. **[SAFETY-CRITICAL] `/api/cron/regime` is still crypto** — fetches BTC/ETH/SOL from CoinGecko and writes `trading_regime` (`app/api/cron/regime/route.ts`). It does NOT compute regime for the 10 equities. v3 equity regime is computed inline in the proposal pipeline and is **not persisted** to `trading_regime`.
3. **[CLEANUP] Stale read commands.** `trading:regime`, `trading:brief`, `trading:positions` read `trading_regime` (crypto rows) and `trading_open_positions` (crypto-era). They reflect the OLD system, not v3 equities. `trading:size`/help still say "BTC", "AUD", "2%".
4. **[SAFETY-CRITICAL] Data Integrity Guard is referenced but not computed.** `risk-gate.ts` blocks when `data_integrity_ok=false`, but nothing ever computes freshness from `Quote.asOf`/`prevClose` — `data_integrity_ok` is hardcoded `true`. The guard is effectively a no-op today.
5. **[SAFETY-CRITICAL] Correlation has no real measurement** (see §4.2): static cluster lookup + placeholder cluster-risk input; no correlation math, no live cluster exposure.
6. **[SAFETY-CRITICAL] Cost inputs are static** (see §4.3): one `FIXTURE_COSTS` constant for all symbols; not live/spread-calibrated.
7. **[SAFETY-CRITICAL] `setup_sample_size` and `strategy_health` are hardcoded** (12 / `'green'`) in `buildRealProposalInput`. So `sample_confidence` on the card is fictional, and the gate's `strategy_health_red` halt never fires from real data. No live setup win-rate stats are wired.
8. **[CLEANUP] Quality scoring is 4 of 6 components.** `scoreQuality` computes trend/structure/pullback/liquidity; `sector_strength` and `market_alignment` are frozen at 5 and excluded from the score (`SCORE_COMPONENT_MODE='four'`, `lib/quality.ts`). Flip to `'six'` when sector/market regime data exists.
9. **[SAFETY-CRITICAL] Button decisions use canned thesis/reason.** Approve sends `founder_thesis='approved_via_button'`, skip sends `reason_code='personal_override'` (`route.ts:245`). The "written thesis" discipline is satisfied only nominally; richer capture (a reply-flow) is unbuilt.
10. **[SAFETY-CRITICAL] Approve is not re-validated against live portfolio at tap time** — it trusts the send-time gate stored on the proposal (documented in `propose.ts:23-31`). Staleness window ≈ card expiry (~15 min).
11. **[CLEANUP] Regime tier 5 is unreachable** (§4.1) — expansion never produced; only tiers 2/3/4 emitted.
12. **[CLEANUP] No market-holiday calendar** in the scanner (`scanner.ts` header) — runs on US holidays but harmlessly (finds stale bars, sends nothing).
13. **[CLEANUP] `4h` timeframe unsupported** by `AlpacaFeed` though the `MarketFeed`/`Timeframe` type permits it.
14. **[CLEANUP] Shadow forward bars come from a single Alpaca pull at command time** (`route.ts handleShadows`); there is no scheduled shadow cron — shadows resolve only when `trading:shadows` is run manually.
15. **[CLEANUP] No live position/exit management for v3 equities** — there is no v3 positions table; exit logic is used only for shadow phantoms. (By design for an intelligence layer, but stated so it isn't mistaken for built execution.)
16. **[SAFETY-CRITICAL] Permissive RLS** (§5) — relies on service-role-only access, not row policies, on a shared DB.

---

_This spec is canonical per `CLAUDE.md`. When code and spec conflict, the spec wins unless the founder says otherwise — but where this spec marks something NOT-BUILT, the code is the truth about current state and the mark is the work to be done._
