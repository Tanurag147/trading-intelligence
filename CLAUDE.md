# Trading Intelligence System

You are working inside a personal trading intelligence platform for discretionary swing trading.
Read this file completely before taking any action in this project.

---

## Identity

This system belongs to a solo founder and trader. It is not a SaaS product.
There are no other users. All database writes are yours. All Telegram messages go to you.

---

## Infrastructure

| Component | Detail |
|---|---|
| Supabase | Project: `wjfsiyxqxyollbcuzjsv` (Gautam Command, ap-northeast-1) |
| Vercel | This project — handles Telegram webhook + cron jobs |
| Telegram bot | @tanurag_trading_bot (command surface) |
| n8n | ops.sillive.com.au — **do not touch WF00, WF13–WF19** |
| Exchange | Independent Reserve (BTC, ETH, SOL) |
| Charting | TradingView (4H + Daily timeframes) |

---

## Database — Supabase Tables

All tables are prefixed `trading_` and are in the `public` schema.
**Never write to `agent_tasks`, `tasks`, or any non-`trading_` table.**

| Table | Purpose |
|---|---|
| `trading_positions` | Every trade — entry, exit, R-multiple, journal fields |
| `trading_regime` | Daily ADX/EMA/ATR regime detection per asset |
| `trading_setups` | Named setup types with accumulated win rate stats |
| `trading_signals` | Every signal that fires, acted on or not |
| `trading_journal` | One row per trading day |
| `trading_portfolio_state` | Equity curve snapshots for drawdown tracking |

Views available:
- `trading_open_positions` — live positions
- `trading_setup_performance` — win rate × expectancy by setup × regime
- `trading_weekly_summary` — rolling 7-day R-multiple stats

---

## Assets Being Traded

- **BTC** — primary, highest conviction
- **ETH** — secondary
- **SOL** — tertiary
- BTC, ETH, SOL are >0.85 correlated. Max one crypto long at a time unless combined risk ≤ 2%

---

## The Four Rules (Non-Negotiable)

Every trade must satisfy all four before entry:

1. **Max 2% capital risk per trade** — position size calculated from stop distance
2. **Written entry reason** — specific, must reference level/signal/pattern
3. **Hard stop loss** — real platform order, not mental
4. **Minimum 2:1 reward-to-risk** — |target−entry| / |entry−stop| ≥ 2.0

A trade that fails any rule does not get entered. No exceptions.

---

## Regime Logic

Regime is calculated nightly (7AM ACST) from 90 days of 4H candles aggregated to daily.

| Regime | Condition |
|---|---|
| `trending_up` | ADX(14) > 25 AND price > EMA(20) |
| `trending_down` | ADX(14) > 25 AND price < EMA(20) |
| `ranging` | ADX(14) ≤ 25 AND ATR ratio ≤ 1.5 |
| `volatile` | ATR ratio > 1.5 (current ATR vs 30-day average) |

**Regime gates all signals.** A signal valid in trending is not valid in ranging.

Signal compatibility (general):
- RSI bounce from support → valid in `ranging`, `trending_up`
- EMA trend continuation → valid in `trending_up` only
- VWAP reclaim → valid in `trending_up`, `trending_down`
- Support breakout retest → valid in `trending_up` only
- Volume expansion breakout → valid in `trending_up` only

---

## Risk Management Rules

| Threshold | Action |
|---|---|
| Single trade | Max 2% capital |
| Total portfolio | Max 6% deployed risk (3 concurrent trades) |
| Volatile regime | Halve all position sizes (1% per trade max) |
| 5% drawdown from peak | Review all open trades, no new entries |
| 10% drawdown | Halve position sizes for 2 weeks |
| 15% drawdown | Stop trading, full system review |
| 20% drawdown | System failure — start over from Phase 0 |

---

## R-Multiple

**All performance is measured in R-multiples, not % or AUD P&L.**

- R = result expressed as multiples of initial risk
- Win of $200 on a $100 risk = +2.0R
- Loss of $100 on a $100 risk = −1.0R
- Target for the system: positive expectancy (avg R across all trades > 0)

---

## What Stays Manual Forever

- Final entry decision (you, not the bot)
- Stop loss placement (chart-based, not formula)
- Early exit when thesis changes
- Setup quality scoring (1–5) before entry
- Weekly review reflection (written by you)

---

## Telegram Commands (Bot Handles Automatically)

| Command | Description |
|---|---|
| `trading:regime` | Today's regime for BTC/ETH/SOL |
| `trading:size BTC 65000 63500` | Position sizing calculator |
| `trading:positions` | Open trades |
| `trading:brief` | Regime + open positions summary |
| `trading:help` | Command list |

---

## Claude Code Slash Commands (AI Analysis — Run in Terminal)

| Command | Description |
|---|---|
| `/pre-trade` | Adversarial analysis before entering a trade |
| `/weekly-review` | Sunday R-multiple performance report |
| `/briefing` | Morning market brief with regime context |

---

## Coding Standards

- TypeScript strict mode
- No `any` types
- Server-only Supabase client (service role key — never expose to client)
- No autonomous trade execution — never write code that places orders
- No Anthropic API calls — AI runs via Claude Code (Max subscription), not embedded API
- Vercel cron endpoints must verify `CRON_SECRET` header
- All Telegram responses use Markdown parse mode

---

## Environment Variables Required

```
SUPABASE_URL=https://wjfsiyxqxyollbcuzjsv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
TRADING_BOT_TOKEN=...
TELEGRAM_TRADING_CHAT_ID=...
CRON_SECRET=...
```

---

## Key Principle

You are an intelligence layer, not an execution layer.
Your job is to inform better decisions, enforce the four rules, and surface patterns.
You never place trades. You never make autonomous decisions. You challenge entries, not confirm them.
