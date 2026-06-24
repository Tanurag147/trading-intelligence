import { NextResponse } from 'next/server'
import { runScan } from '@/lib/scanner'

/**
 * GET /api/cron/scan — scheduled watchlist scan that auto-sends Telegram proposal
 * cards for symbols passing the risk gate (silent on blocks/cooldowns/caps).
 *
 * Auth mirrors /api/cron/regime exactly: require `Authorization: Bearer <CRON_SECRET>`,
 * else 401. The recipient is fixed by env — auto-proposals go to ONE owner:
 *   - chatId           = TELEGRAM_TRADING_CHAT_ID  (where the card is delivered)
 *   - telegram_user_id = SCAN_OWNER_TELEGRAM_ID    (who may act on the buttons —
 *                        nonces are bound to this id, so only the owner's taps work)
 *
 * Per-symbol failures are captured inside runScan (outcome='error' in details) and
 * never throw the endpoint; we return 200 with the scan summary either way.
 *
 * SCHEDULE CAVEAT (vercel.json can't hold comments, so it's documented here):
 * the cron schedule is "(slash)15 13-21 * * 1-5" — every 15 min, 13:00–21:00 UTC
 * (≈ the US session incl. a DST buffer), Mon–Fri. 15-MINUTE-GRANULARITY CRONS
 * REQUIRE VERCEL PRO. On the Hobby plan this entry will NOT fire every 15 min
 * (Hobby is limited to daily crons) — in that case trigger this same endpoint
 * from n8n on a 15-min schedule with an "Authorization: Bearer CRON_SECRET"
 * header. The endpoint is identical either way; only the trigger differs.
 * runScan's own market-hours guard means off-session fires are no-ops.
 */
export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const chatId = process.env.TELEGRAM_TRADING_CHAT_ID
  const telegram_user_id = process.env.SCAN_OWNER_TELEGRAM_ID
  if (!chatId || !telegram_user_id) {
    // Config error, not an auth error — return 200 so the cron isn't flagged as
    // failing/retried, but report it clearly.
    return NextResponse.json({
      ok: false,
      error: 'missing TELEGRAM_TRADING_CHAT_ID or SCAN_OWNER_TELEGRAM_ID',
    })
  }

  try {
    const summary = await runScan({ chatId, telegram_user_id })
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    // runScan handles per-symbol errors internally; this only catches a total
    // failure (e.g. AlpacaFeed missing keys). Still return 200 with the reason.
    console.error('scan cron failed', err)
    return NextResponse.json({ ok: false, error: (err as Error).message })
  }
}
