# /weekly-review — Sunday Evening Performance Review

Run every Sunday evening. Takes ~10 minutes.
Pull data from Supabase, generate the report, ask for reflection, write lessons back to the journal.

---

## Step 1 — Pull this week's data

```sql
-- 7-day rolling summary
SELECT * FROM trading_weekly_summary;

-- This week's closed trades with setup names
SELECT
  p.asset, p.direction, p.entry_price, p.exit_price,
  p.r_multiple, p.actual_pnl_aud, p.risk_amount_aud,
  p.followed_all_rules, p.rule_broken,
  p.setup_quality_score, p.regime_at_entry,
  p.emotional_state_entry, p.emotional_state_exit,
  p.pre_trade_reason, p.lessons,
  s.name as setup_name,
  p.entry_time, p.exit_time
FROM trading_positions p
LEFT JOIN trading_setups s ON s.id = p.setup_id
WHERE p.status = 'closed'
  AND p.exit_time >= NOW() - INTERVAL '7 days'
ORDER BY p.exit_time;

-- This week's regime context
SELECT asset, regime, adx_14, atr_ratio, regime_date
FROM trading_regime
WHERE regime_date >= CURRENT_DATE - 7
ORDER BY regime_date, asset;

-- Setup performance (all time, for comparison)
SELECT * FROM trading_setup_performance
WHERE total_trades >= 3
ORDER BY expectancy DESC NULLS LAST;

-- Portfolio state — current drawdown
SELECT total_capital_aud, peak_capital_aud, drawdown_from_peak_pct, trigger_level
FROM trading_portfolio_state
ORDER BY created_at DESC
LIMIT 1;
```

---

## Step 2 — Generate the Week in Numbers

Present clearly:

```
WEEK IN NUMBERS
───────────────────────────────
Trades taken:    X
Wins / Losses:   X / X
Win rate:        X%
Average R:       +X.XR
Total P&L:       +$X AUD
Rule breaks:     X
```

If average R is negative: flag it clearly. If rule breaks > 0: name which rules.

---

## Step 3 — Trade-by-Trade Review

For each closed trade this week:

**Format:**
```
[ASSET] [DIRECTION] — [WIN +XR / LOSS -XR]
Setup: [setup name] | Regime: [regime at entry]
Entry reason: [their written reason]
Rules followed: [YES / NO — which broke]
Lesson: [their post-trade note if exists]
```

After listing all trades, identify:
- **Best trade**: why did it work? Was it the setup, regime, or discipline?
- **Worst trade**: what specifically went wrong?

---

## Step 4 — Regime × Setup Alignment

Look at what regimes were in play and what setups were taken:

- Were the setups compatible with the regimes?
- Any mismatches? (e.g., breakout trade taken in ranging regime)
- What setups would have been better given this week's regimes?

---

## Step 5 — All-Time Setup Performance Check

Compare this week's setups to their all-time stats:
- Is the user trading their highest-expectancy setups?
- If they have a setup with < 40% win rate historically, and they traded it this week — flag it
- Which setup has the highest expectancy overall? Are they prioritising it?

Only meaningful once there are 10+ total trades. Before that, note: "Not enough data yet — keep logging."

---

## Step 6 — Discipline Audit

Ask directly:
1. Did you follow all four rules on every trade this week?
2. Did you enter any trade without running /pre-trade first?
3. Did you exit any trade early (before stop or target)? If so, why?
4. Were there setups you saw and passed on? Were those good decisions?

If there were rule breaks — don't lecture. Just ask: "What would you do differently?"

---

## Step 7 — One Lesson

Ask:
> "What is the single most important lesson from this week's trading? Write it in one sentence."

Wait for the response. Record it.

---

## Step 8 — Write Back to Supabase

Insert or update today's journal entry:

```sql
INSERT INTO trading_journal (
  journal_date, trades_taken, discipline_score, lessons, regime_summary
)
VALUES (
  CURRENT_DATE,
  [trades_taken_count],
  [discipline_score],
  [their one lesson],
  [brief regime summary for the week]
)
ON CONFLICT (journal_date) DO UPDATE SET
  trades_taken = EXCLUDED.trades_taken,
  discipline_score = EXCLUDED.discipline_score,
  lessons = EXCLUDED.lessons,
  regime_summary = EXCLUDED.regime_summary,
  updated_at = NOW();
```

Ask for the discipline score (1–10) before writing:
- 1–4: "What specifically failed this week?"
- 5–7: "What's one thing to tighten?"
- 8–10: "What's working — don't change it."

---

## Step 9 — Next Week Preparation

Pull today's regime data and present:
1. Current regime for each asset
2. Which setups are valid in those regimes
3. Ask: "What are you watching for next week? Name 1–2 specific setups."
4. Any major macro events in the next 7 days to be aware of? (ask the user — you don't have live economic calendar)

---

## Step 10 — Portfolio State Snapshot

```sql
INSERT INTO trading_portfolio_state (
  snapshot_time, total_capital_aud, deployed_risk_pct,
  open_pnl_aud, peak_capital_aud, drawdown_from_peak_pct,
  trigger_level, open_positions
)
VALUES (
  NOW(),
  [current_capital],
  [deployed_risk_pct],
  [open_pnl],
  [peak_capital],
  [drawdown_pct],
  [trigger_level: 'normal'|'watch'|'reduce'|'stop'],
  [open_positions as JSON]
);
```

Ask: "What is your current total capital in AUD?" to get the right number.

Determine trigger level:
- drawdown < 5%: `normal`
- 5–10%: `watch`
- 10–15%: `reduce`
- > 15%: `stop`

---

## Tone

Direct, not encouraging. You are not a therapist. If the week was bad, say so clearly.
If the week was good, acknowledge it briefly and move on — complacency is also a risk.
The goal is pattern recognition and discipline reinforcement, not emotional management.
