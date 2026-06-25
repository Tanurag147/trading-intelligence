# CLAUDE.md — Trading OS v3 (trading-intelligence)

> Global operating protocol is inherited from `~/.claude/CLAUDE.md` — not repeated here. This file holds only project-specific rules.

## 1. HARD BOUNDARIES — NEVER CROSS
- No autonomous execution. Founder interaction is Approve / Skip / Snooze on proposal cards via Telegram; nothing executes without my tap. Never write code that places orders or bypasses this decision interface.
- Failed-gate proposal cards can NEVER be approved. A card that failed its risk gate is dead — no override path, no exception, no "just this once."
- Filter-stability rules are absolute: system rules are not overridable by in-the-moment discretion. The behavior gap (rationalizing past a rule in the moment) is the core risk this system exists to prevent. Never build an escape hatch that lets a rule be relaxed at decision time.
- The four Phase 1 engines — regime, correlation, cost, exit — are MANDATORY, not optional or deferrable. Cost modeling and exit discipline are mandatory Phase 1, never deferred — these are where automated trading systems fail; they are not "later."
- Never write to any non-`trading_` table. This is a SHARED database (other systems live here); writes outside the `trading_` prefix cross a system boundary. v3 currently writes only `trading_decisions`, `trading_open_positions`, `trading_proposals`, `trading_regime`, `trading_scan_alerts`, `trading_shadow_results`.
- Never expose the Supabase service-role client/key to the client side. Server-only. This is a shared DB containing other systems' data — a leaked service-role key is full-database compromise.
- No Anthropic/LLM API calls embedded in this repo. AI analysis runs via Claude Code, not an embedded API. (Verified: no `anthropic`/`openai` dependency, no API usage in code — do not introduce one without my go-ahead.)
- Cron endpoints must verify `CRON_SECRET` (`Authorization: Bearer <CRON_SECRET>`). Both `/api/cron/regime` and `/api/cron/scan` enforce this — never add a cron route without it.
- Do not touch n8n WF00 and WF13–WF19 on ops.sillive.com.au — these are live, published production workflows (verified 2026-06-25). Never modify, disable, or delete them without my explicit go-ahead.

## 2. BUILD DISCIPLINE
- `TRADING_OS_SPEC_v3.md` is canonical. It governs. If code and spec conflict, the spec wins unless I say otherwise. See the spec's STATUS HONESTY note and §7 SAFETY-CRITICAL gaps for the current built-vs-enforcing state — engines are coded but the risk gate is not yet enforcing against live state.
- Build order: pure in-memory modules BEFORE any persistence (`lib/feed.ts`, `lib/proposal.ts`, `lib/risk-gate.ts`, `lib/exit-stepper.ts`, `lib/decide.ts`, `lib/build-proposal.ts` before DB). All six exist.
- Vertical-slice, depth-first: a full working slice before breadth.
- Migrations applied via Supabase MCP `apply_migration`, NEVER `supabase db push` or CLI auto-apply.
- Migrations live in `supabase/migrations/`. Current state: 3 — `0001_trading_os_v3.sql`, `0002_callback_nonces.sql`, `0003_scanner_state.sql` (all present in the shared project's ledger).

## 3. STACK FACTS
- Framework: Next.js 16.2.6 / React 19 / TypeScript (strict) / Vercel / Supabase. Tests: Vitest. Supabase client is server-only (service-role key).
- Supabase project ref: `wjfsiyxqxyollbcuzjsv`. ⚠️ SHARED project — the same DB as Gautam Command and other systems. The `trading_*` migrations sit in one ledger alongside `00xx` (Gautam Command), `pramaanx_*`, `director_os_*`, `travel_*`, etc. Never assume isolation; see the non-`trading_` write-ban above.
- Data feed: Alpaca. `AlpacaFeed` (`lib/feeds/alpaca.ts`) implements the `MarketFeed` interface (`lib/feed.ts`) — over-fetches by date window then slices for bars; only `1d` timeframe supported; non-200 fails closed (401 auth / 403 tier called out distinctly). `FixtureFeed` is the test feed.
- Finnhub rejected due to unreliable candle access (403 on /stock/candle); Alpaca is the feed.
- Phase 1 universe (10 symbols): AAPL, MSFT, NVDA, AMZN, META, GOOGL, TSLA, AMD, SPY, QQQ. Defined in both `app/api/telegram/route.ts` and the auto-scanner `WATCHLIST` (`lib/scanner.ts`) — kept in sync.
- Telegram: webhook verifies the `x-telegram-bot-api-secret-token` header (`TELEGRAM_WEBHOOK_SECRET`); single-use per-action nonces (`lib/nonce.ts`); callback format `v3:<action>:<proposal_id>` with actions approve/skip/snooze (`lib/telegram.ts`).
- Shadow Exit Tracker: `lib/shadow-tracker.ts` — phantom-trades shadow-routed (skipped/expired) proposals through the existing exit stepper, persists `would_have_*` verdicts to `trading_shadow_results`.
