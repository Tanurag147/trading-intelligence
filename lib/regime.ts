export type Regime = 'trending_up' | 'trending_down' | 'ranging' | 'volatile'

export interface RegimeResult {
  asset: string
  regime: Regime
  adx_14: number
  atr_ratio: number
  price_above_ema20: boolean
  close_price: number
  ema20: number
  regime_date: string
}

interface DailyCandle {
  date: string
  open: number
  high: number
  low: number
  close: number
}

function aggregateToDaily(
  ohlcRaw: [number, number, number, number, number][]
): DailyCandle[] {
  const byDay = new Map<string, DailyCandle>()
  const ordered = [...ohlcRaw].sort((a, b) => a[0] - b[0])

  for (const [ts, open, high, low, close] of ordered) {
    const date = new Date(ts).toISOString().slice(0, 10)
    const existing = byDay.get(date)
    if (!existing) {
      byDay.set(date, { date, open, high, low, close })
    } else {
      existing.high = Math.max(existing.high, high)
      existing.low = Math.min(existing.low, low)
      existing.close = close
    }
  }

  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function trueRanges(candles: DailyCandle[]): number[] {
  const out: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]
    const prev = candles[i - 1]
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    )
    out.push(tr)
  }
  return out
}

function wilderSmooth(values: number[], period: number): number[] {
  if (values.length < period) return []
  const out: number[] = []
  let prior = 0
  for (let i = 0; i < period; i++) prior += values[i]
  out.push(prior / period)
  for (let i = period; i < values.length; i++) {
    const next = (out[out.length - 1] * (period - 1) + values[i]) / period
    out.push(next)
  }
  return out
}

function directionalMovement(candles: DailyCandle[]): {
  plusDM: number[]
  minusDM: number[]
} {
  const plusDM: number[] = []
  const minusDM: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]
    const prev = candles[i - 1]
    const upMove = cur.high - prev.high
    const downMove = prev.low - cur.low
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }
  return { plusDM, minusDM }
}

function calculateADX(candles: DailyCandle[], period: number): number[] {
  const tr = trueRanges(candles)
  const { plusDM, minusDM } = directionalMovement(candles)

  const smoothTR = wilderSmooth(tr, period)
  const smoothPlusDM = wilderSmooth(plusDM, period)
  const smoothMinusDM = wilderSmooth(minusDM, period)

  const dx: number[] = []
  for (let i = 0; i < smoothTR.length; i++) {
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100
    const sum = plusDI + minusDI
    dx.push(sum === 0 ? 0 : (Math.abs(plusDI - minusDI) / sum) * 100)
  }

  return wilderSmooth(dx, period)
}

function calculateEMA(values: number[], period: number): number[] {
  if (values.length < period) return []
  const k = 2 / (period + 1)
  const out: number[] = []
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  out.push(seed / period)
  for (let i = period; i < values.length; i++) {
    out.push(values[i] * k + out[out.length - 1] * (1 - k))
  }
  return out
}

function calculateATR(candles: DailyCandle[], period: number): number[] {
  return wilderSmooth(trueRanges(candles), period)
}

export function calculateRegime(
  asset: string,
  ohlcRaw: [number, number, number, number, number][]
): RegimeResult {
  const daily = aggregateToDaily(ohlcRaw)
  if (daily.length < 28) {
    throw new Error(
      `Not enough daily candles for ${asset}: got ${daily.length}, need ≥28`
    )
  }

  const closes = daily.map((c) => c.close)
  const adxSeries = calculateADX(daily, 14)
  const emaSeries = calculateEMA(closes, 20)
  const atrSeries = calculateATR(daily, 14)

  const adx14 = adxSeries[adxSeries.length - 1]
  const ema20 = emaSeries[emaSeries.length - 1]
  const currentATR = atrSeries[atrSeries.length - 1]
  const last = daily[daily.length - 1]

  const atrWindow = atrSeries.slice(-30)
  const atrAvg = atrWindow.reduce((s, v) => s + v, 0) / atrWindow.length
  const atrRatio = atrAvg === 0 ? 0 : currentATR / atrAvg

  const priceAboveEma20 = last.close > ema20

  let regime: Regime
  if (atrRatio > 1.5) {
    regime = 'volatile'
  } else if (adx14 > 25 && priceAboveEma20) {
    regime = 'trending_up'
  } else if (adx14 > 25 && !priceAboveEma20) {
    regime = 'trending_down'
  } else {
    regime = 'ranging'
  }

  return {
    asset,
    regime,
    adx_14: Number(adx14.toFixed(2)),
    atr_ratio: Number(atrRatio.toFixed(3)),
    price_above_ema20: priceAboveEma20,
    close_price: last.close,
    ema20: Number(ema20.toFixed(2)),
    regime_date: last.date,
  }
}
