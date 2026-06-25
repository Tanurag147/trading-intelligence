# MASTER_STATE — Trading OS v3 (trading-intelligence)
_Last updated: 2026-06-25 by Claude Code_

## NOW (current focus)
- Governance just established: `CLAUDE.md`, canonical `TRADING_OS_SPEC_v3.md`, this file.
- System is NOT live — no real money. Next phase: close safety-critical gaps toward "gate enforces against live state."

## DONE (verified, shipped)
> "BUILT" = logic coded and wired, NOT "enforcing against live state." See spec STATUS HONESTY.
- Six in-memory modules: `lib/feed.ts` (MarketFeed contract), `lib/proposal.ts` (types + DEFAULT_LIMITS), `lib/risk-gate.ts` (pure fail-closed gate), `lib/build-proposal.ts` (assembler + expectancy), `lib/decide.ts` (decision reducer), `lib/exit-stepper.ts` (bar-by-bar exit sim).
- Feed: `lib/feeds/alpaca.ts` AlpacaFeed implements MarketFeed (over-fetch+slice bars, trade-price-preferred quote, fail-closed); `lib/feeds/fixture.ts` for tests.
- Regime engine: `lib/regime.ts` (ADX/EMA/ATR, ≥28 daily candles).
- Quality engine: `lib/quality.ts` (4 of 6 components real; `SCORE_COMPONENT_MODE='four'`).
- Scanner: `lib/scanner.ts` — 10-symbol Phase 1 universe, market-hours guard, cooldown + daily-cap anti-spam.
- Telegram flow: `lib/telegram.ts` (HTML cards, Approve/Skip/Snooze, `v3:<action>:<proposal_id>`), `lib/nonce.ts` (single-use atomic-burn nonces), webhook secret-token verified in `app/api/telegram/route.ts`.
- Shadow Exit Tracker: `lib/shadow-tracker.ts` — phantom-trades skipped/expired proposals via the exit stepper → `trading_shadow_results`.
- Persistence: `lib/persist.ts`; migrations `supabase/migrations/0001_trading_os_v3`, `0002_callback_nonces`, `0003_scanner_state` → `trading_proposals/_decisions/_shadow_results/_callback_nonces/_scan_alerts`.
- Cron routes: `app/api/cron/scan` + `app/api/cron/regime`, both CRON_SECRET-protected (⚠️ regime cron still crypto — spec Gap 2).
- Governance docs: `CLAUDE.md`, `TRADING_OS_SPEC_v3.md`.
- Four engines (status per spec §4): Regime BUILT · Cost BUILT · Exit BUILT · Correlation PARTIAL. BUILT = logic wired, NOT enforcing against live state.

## IN PROGRESS
- Nothing actively mid-edit. Governance docs landed; no code change open.

## BLOCKED
- Nothing hard-blocked.
- Gating principle: nothing points at real capital until the risk gate enforces against live state (see spec STATUS HONESTY + §7).

## NEXT (ordered — driven by spec §7 safety-critical gaps, dependency order)
1. Portfolio context (Gap 1) — gate reads real open positions/risk/exposure, not the always-passing stub. Foundation; other checks depend on it.
2. Regime cron (Gap 2) — replace crypto BTC/ETH/SOL job with a real equity regime job over the 10 symbols, persisted.
3. Data Integrity Guard (Gap 4) — compute real freshness instead of hardcoded true.
4. Correlation measurement (Gap 5) — real `cluster_risk_pct` instead of hardcoded.
5. Cost calibration (Gap 6) — live cost inputs instead of the one static `FIXTURE_COSTS` constant.
6. Sample-size / strategy-health reality (Gap 7) — so the RED-health halt can actually fire.
7. Approve re-validation at tap time (Gap 10) — re-check gate against live portfolio at approval, not just at proposal build.
- ⭐ MILESTONE: gaps 1, 2, 4 (ideally + 5,6,7) = "GATE ENFORCES AGAINST LIVE STATE." Do NOT point at real capital before this line.
- Cleanup gaps (spec-tagged CLEANUP): crypto read commands, help text, holiday calendar, 4h timeframe, shadow cron, RLS tightening — real work, no urgency.

## KEY FACTS
- Supabase project ref: `wjfsiyxqxyollbcuzjsv` (SHARED — see RISKS).
- Migrations: `supabase/migrations/`, current 3 (`0001_trading_os_v3`, `0002_callback_nonces`, `0003_scanner_state`). Applied via MCP `apply_migration`.
- Stack: Next.js 16 / React 19 / TypeScript strict / Vercel / Supabase. Tests: Vitest.
- Feed: Alpaca (Finnhub rejected).
- Git: branch `main`, ahead of `origin/main` by 3 incl. this commit (not pushed).

## RISKS
- SHARED Supabase project `wjfsiyxqxyollbcuzjsv` — same DB as Gautam Command (CHSA participant data) and other systems. Write ONLY `trading_` tables. Permissive RLS means the boundary rests on the service-role key never leaking (spec Gap 16, SAFETY-CRITICAL).
- GATE NOT YET ENFORCING — v3 engines are coded but run on placeholder/static inputs; the risk gate does not yet fire against live state. 9 safety-critical gaps documented in spec §7. System is NOT live with real money and must not be until the enforcement milestone above is met.

<!--
MAINTENANCE RULES (keep this block):
- Update NOW, DONE, IN PROGRESS, BLOCKED, NEXT after any significant completed work.
- Move items between sections rather than rewriting the whole file.
- Always update the "Last updated" line.
- This file is the single source of truth for project status. If it conflicts with memory, this file wins.
-->
