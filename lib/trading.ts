export interface PositionSize {
  units: number
  riskAmount: number
  riskPct: number
}

export function calculatePositionSize(
  capital: number,
  entryPrice: number,
  stopLoss: number,
  riskPct: number = 0.02
): PositionSize {
  const riskAmount = capital * riskPct
  const riskPerUnit = Math.abs(entryPrice - stopLoss)
  if (riskPerUnit === 0) {
    return { units: 0, riskAmount: 0, riskPct }
  }
  const units = riskAmount / riskPerUnit
  return {
    units: Number(units.toFixed(8)),
    riskAmount: Number(riskAmount.toFixed(2)),
    riskPct,
  }
}

export function calculateRMultiple(
  entryPrice: number,
  exitPrice: number,
  stopLoss: number,
  direction: 'long' | 'short'
): number {
  const initialRisk = Math.abs(entryPrice - stopLoss)
  if (initialRisk === 0) return 0
  const result =
    direction === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice
  return Number((result / initialRisk).toFixed(2))
}

export function calculateRRRatio(
  entryPrice: number,
  targetPrice: number,
  stopLoss: number,
  direction: 'long' | 'short'
): number {
  const risk = Math.abs(entryPrice - stopLoss)
  if (risk === 0) return 0
  const reward =
    direction === 'long' ? targetPrice - entryPrice : entryPrice - targetPrice
  return Number((reward / risk).toFixed(2))
}

export function minimumTarget(
  entryPrice: number,
  stopLoss: number,
  direction: 'long' | 'short',
  minRR: number = 2.0
): number {
  const risk = Math.abs(entryPrice - stopLoss)
  const distance = risk * minRR
  const target = direction === 'long' ? entryPrice + distance : entryPrice - distance
  return Number(target.toFixed(2))
}
