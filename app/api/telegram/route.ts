import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { sendMessage, regimeEmoji } from '@/lib/telegram'
import {
  calculatePositionSize,
  calculateRRRatio,
  minimumTarget,
} from '@/lib/trading'

interface TelegramMessage {
  chat: { id: number }
  text?: string
}

interface TelegramUpdate {
  message?: TelegramMessage
  channel_post?: TelegramMessage
}

const HELP_TEXT = `*Trading Intelligence — Commands*

\`trading:regime\` — today's regime for BTC/ETH/SOL
\`trading:size <asset> <entry> <stop> [capital]\` — position sizing
\`trading:positions\` — open trades
\`trading:brief\` — regime + open positions
\`trading:help\` — this message

Default capital = $5000 AUD. Risk per trade = 2%.`

export async function POST(req: Request) {
  try {
    const update = (await req.json()) as TelegramUpdate
    const msg = update.message ?? update.channel_post
    if (!msg || !msg.text) {
      return NextResponse.json({ ok: true })
    }

    const chatId = String(msg.chat.id)
    const raw = msg.text.trim()
    const stripped = raw.startsWith('trading:') ? raw.slice('trading:'.length).trim() : raw
    const [cmd, ...args] = stripped.split(/\s+/)

    switch (cmd.toLowerCase()) {
      case 'regime':
        await handleRegime(chatId)
        break
      case 'size':
        await handleSize(chatId, args)
        break
      case 'positions':
        await handlePositions(chatId)
        break
      case 'brief':
        await handleBrief(chatId)
        break
      case 'help':
      case 'start':
      case '/start':
      case '/help':
        await sendMessage(chatId, HELP_TEXT)
        break
      default:
        await sendMessage(
          chatId,
          `Unknown command: \`${cmd}\`\n\n${HELP_TEXT}`
        )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('telegram webhook error', err)
    try {
      const update = await safeJson(req)
      const chatId = update?.message?.chat.id ?? update?.channel_post?.chat.id
      if (chatId) {
        await sendMessage(
          String(chatId),
          `⚠️ Error handling command: ${(err as Error).message}`
        )
      }
    } catch {
      // swallow — Telegram requires 200
    }
    return NextResponse.json({ ok: true })
  }
}

async function safeJson(req: Request): Promise<TelegramUpdate | null> {
  try {
    return (await req.clone().json()) as TelegramUpdate
  } catch {
    return null
  }
}

async function handleRegime(chatId: string): Promise<void> {
  const { data, error } = await supabase
    .from('trading_regime')
    .select('asset, regime, adx_14, atr_ratio, price_above_ema20, close_price, ema20, regime_date')
    .eq('regime_date', new Date().toISOString().slice(0, 10))
    .order('asset')

  if (error) throw error
  if (!data || data.length === 0) {
    await sendMessage(chatId, '⚠️ No regime data for today yet — cron may not have run.')
    return
  }

  const lines = data.map((r) => {
    const emoji = regimeEmoji(r.regime as string)
    const above = r.price_above_ema20 ? '✅' : '⛔'
    return `${emoji} *${r.asset}*: ${(r.regime as string).toUpperCase()}\n   ADX ${r.adx_14} | ATR× ${r.atr_ratio}\n   $${r.close_price} ${above} EMA20 $${r.ema20}`
  })

  await sendMessage(
    chatId,
    `*Regime — ${data[0].regime_date}*\n\n${lines.join('\n\n')}`
  )
}

async function handleSize(chatId: string, args: string[]): Promise<void> {
  if (args.length < 3) {
    await sendMessage(
      chatId,
      'Usage: `trading:size <asset> <entry> <stop> [capital]`\n\nExample: `trading:size BTC 65000 63500`'
    )
    return
  }

  const [asset, entryStr, stopStr, capitalStr] = args
  const entry = Number(entryStr)
  const stop = Number(stopStr)
  const capital = capitalStr ? Number(capitalStr) : 5000

  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(capital)) {
    await sendMessage(chatId, '⚠️ Invalid numbers. All prices and capital must be numeric.')
    return
  }

  const direction: 'long' | 'short' = entry > stop ? 'long' : 'short'
  const size = calculatePositionSize(capital, entry, stop)
  const target2R = minimumTarget(entry, stop, direction, 2.0)
  const target25R = minimumTarget(entry, stop, direction, 2.5)
  const rrAtTarget2 = calculateRRRatio(entry, target2R, stop, direction)

  const stopDist = Math.abs(entry - stop)
  const stopPct = ((stopDist / entry) * 100).toFixed(2)

  await sendMessage(
    chatId,
    `*Position Size — ${asset.toUpperCase()}*\n\n` +
      `Direction: ${direction}\n` +
      `Entry: $${entry}\n` +
      `Stop: $${stop} (${stopPct}% away)\n` +
      `Capital: $${capital} AUD\n\n` +
      `*Units:* ${size.units}\n` +
      `*Risk:* $${size.riskAmount} AUD (${(size.riskPct * 100).toFixed(1)}%)\n\n` +
      `Target for 2.0R: $${target2R} (RR ${rrAtTarget2})\n` +
      `Target for 2.5R: $${target25R}`
  )
}

async function handlePositions(chatId: string): Promise<void> {
  const { data, error } = await supabase
    .from('trading_open_positions')
    .select('asset, direction, entry_price, stop_loss, target_price, risk_amount_aud, regime_at_entry, entry_time')

  if (error) throw error
  if (!data || data.length === 0) {
    await sendMessage(chatId, '*Open Positions:* none')
    return
  }

  const lines = data.map((p) => {
    const arrow = p.direction === 'long' ? '🟢 LONG' : '🔴 SHORT'
    return `${arrow} *${p.asset}*\n   entry $${p.entry_price} | stop $${p.stop_loss} | target $${p.target_price}\n   risk $${p.risk_amount_aud} AUD | regime: ${p.regime_at_entry ?? '—'}`
  })

  await sendMessage(chatId, `*Open Positions*\n\n${lines.join('\n\n')}`)
}

async function handleBrief(chatId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)

  const [regimeRes, positionsRes] = await Promise.all([
    supabase
      .from('trading_regime')
      .select('asset, regime, adx_14, atr_ratio, price_above_ema20, close_price, ema20')
      .eq('regime_date', today)
      .order('asset'),
    supabase
      .from('trading_open_positions')
      .select('asset, direction, entry_price, stop_loss, target_price, risk_amount_aud'),
  ])

  if (regimeRes.error) throw regimeRes.error
  if (positionsRes.error) throw positionsRes.error

  const regimeBlock =
    regimeRes.data && regimeRes.data.length > 0
      ? regimeRes.data
          .map((r) => {
            const emoji = regimeEmoji(r.regime as string)
            return `${emoji} ${r.asset}: ${(r.regime as string).toUpperCase()} (ADX ${r.adx_14}, ATR× ${r.atr_ratio})`
          })
          .join('\n')
      : '⚠️ No regime data for today.'

  const positionsBlock =
    positionsRes.data && positionsRes.data.length > 0
      ? positionsRes.data
          .map((p) => {
            const arrow = p.direction === 'long' ? '🟢' : '🔴'
            return `${arrow} ${p.asset} ${p.direction} — entry $${p.entry_price}, stop $${p.stop_loss}, risk $${p.risk_amount_aud}`
          })
          .join('\n')
      : 'No open positions.'

  await sendMessage(
    chatId,
    `*Brief — ${today}*\n\n*Regime*\n${regimeBlock}\n\n*Open*\n${positionsBlock}`
  )
}
