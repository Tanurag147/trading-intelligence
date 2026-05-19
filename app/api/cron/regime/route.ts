import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { calculateRegime, type RegimeResult } from '@/lib/regime'
import { sendMessage, regimeEmoji } from '@/lib/telegram'

const ASSETS: { symbol: string; coingeckoId: string }[] = [
  { symbol: 'BTC', coingeckoId: 'bitcoin' },
  { symbol: 'ETH', coingeckoId: 'ethereum' },
  { symbol: 'SOL', coingeckoId: 'solana' },
]

interface AssetResultOk {
  asset: string
  ok: true
  regime: RegimeResult
}

interface AssetResultErr {
  asset: string
  ok: false
  error: string
}

type AssetResult = AssetResultOk | AssetResultErr

async function fetchOhlc(
  coingeckoId: string
): Promise<[number, number, number, number, number][]> {
  const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/ohlc?vs_currency=usd&days=30`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`CoinGecko ${coingeckoId} failed: ${res.status}`)
  }
  return (await res.json()) as [number, number, number, number, number][]
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const results: AssetResult[] = []

  for (let i = 0; i < ASSETS.length; i++) {
    const { symbol, coingeckoId } = ASSETS[i]
    try {
      const ohlc = await fetchOhlc(coingeckoId)
      const regime = calculateRegime(symbol, ohlc)

      const { error } = await supabase
        .from('trading_regime')
        .upsert(
          {
            asset: regime.asset,
            regime: regime.regime,
            adx_14: regime.adx_14,
            atr_ratio: regime.atr_ratio,
            price_above_ema20: regime.price_above_ema20,
            close_price: regime.close_price,
            ema20: regime.ema20,
            regime_date: regime.regime_date,
          },
          { onConflict: 'regime_date,asset' }
        )

      if (error) throw error
      results.push({ asset: symbol, ok: true, regime })
    } catch (err) {
      results.push({
        asset: symbol,
        ok: false,
        error: (err as Error).message,
      })
    }

    if (i < ASSETS.length - 1) await sleep(1100)
  }

  const chatId = process.env.TELEGRAM_TRADING_CHAT_ID
  if (chatId) {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const lines = results.map((r) => {
        if (!r.ok) return `⚠️ *${r.asset}*: error — ${r.error}`
        const reg = r.regime
        const emoji = regimeEmoji(reg.regime)
        const above = reg.price_above_ema20 ? '✅' : '⛔'
        return (
          `${emoji} *${reg.asset}*: ${reg.regime.toUpperCase()}\n` +
          `   ADX ${reg.adx_14} | ATR× ${reg.atr_ratio}\n` +
          `   $${reg.close_price} ${above} EMA20 $${reg.ema20}`
        )
      })
      await sendMessage(
        chatId,
        `*Daily Regime — ${today}*\n\n${lines.join('\n\n')}`
      )
    } catch (err) {
      console.error('telegram send failed', err)
    }
  }

  return NextResponse.json({ ok: true, results })
}
