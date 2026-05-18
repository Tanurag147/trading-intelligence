# /briefing — Morning Market Brief

Run each morning after the regime Telegram arrives (or anytime via terminal).
Takes 3–5 minutes. Gives you structured context before you look at charts.

---

## Step 1 — Pull data

```sql
-- Today's regime (should be populated by 7AM cron)
SELECT asset, regime, adx_14, atr_ratio, price_above_ema20, close_price, ema20, regime_date
FROM trading_regime
WHERE regime_date = CURRENT_DATE
ORDER BY asset;

-- Open positions
SELECT asset, direction, entry_price, stop_loss, target_price,
       risk_amount_aud, entry_time, regime_at_entry, setup_quality_score
FROM trading_open_positions;

-- Rolling 7-day stats for context
SELECT win_rate_pct, avg_r, total_pnl_aud, rule_breaks
FROM trading_weekly_summary;

-- Portfolio state
SELECT total_capital_aud, drawdown_from_peak_pct, trigger_level
FROM trading_portfolio_state
ORDER BY created_at DESC
LIMIT 1;
```

---

## Step 2 — Present the brief

Format:

```
☀️ MORNING BRIEF — [date]
═══════════════════════════════

REGIME
──────
📈 BTC: TRENDING UP | ADX 32 | ATR× 1.1
   $67,420 | ✅ above EMA20 ($65,800)

↔️ ETH: RANGING | ADX 18 | ATR× 0.9
   $3,210 | ⛔ below EMA20 ($3,380)

⚡ SOL: VOLATILE | ADX 22 | ATR× 1.6
   $148 | ✅ above EMA20 ($142)
   ⚠️ Volatile — halve position sizes if trading SOL

OPEN POSITIONS
──────────────
🟢 BTC LONG — entry $65,400 | stop $63,800 | target $69,200
   Risk: $96 AUD | Entry: [date]
   [or: no open positions]

WEEK SO FAR
───────────
3 trades | 2W/1L | Win rate 67% | Avg R +1.8 | P&L +$340 AUD
[or: no trades this week yet]

PORTFOLIO STATUS: NORMAL
Capital: $5,340 AUD | Drawdown from peak: 0%
```

---

## Step 3 — Regime-based guidance

Based on today's regimes, state what setups are valid today:

Examples:
- "BTC trending up → EMA continuation and VWAP reclaim setups valid. RSI bounce at support also viable."
- "ETH ranging → RSI bounce from support is your only valid setup. No breakout trades."
- "SOL volatile → Halve position size if trading. Consider sitting out."

If ALL assets are volatile or trending down: "Consider a no-trade day. Let the market come to you."

---

## Step 4 — Open position check

For each open position:

1. Is the original entry thesis still valid given today's regime?
2. Has price moved enough to consider moving stop to break-even? (general rule: after 1R of profit)
3. Is there any reason to exit early today? (regime change, approaching target)

Don't suggest action unless there's a clear reason. "Hold" is a valid and often correct answer.

---

## Step 5 — One question

End with exactly one question:

> "What's your plan for today — are you looking to enter, manage existing positions, or sit out?"

Wait for the answer. If they say they're looking to enter, remind them to run `/pre-trade` before touching the platform.

---

## Tone

Fast and factual. This is a 3-minute brief, not a lecture.
Present the data, give the regime-based guidance, ask the one question.
Don't pad it. Don't add encouragement. Don't comment on whether markets "look interesting."
