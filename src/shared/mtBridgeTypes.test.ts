import { describe, expect, it } from 'vitest'
import {
  MT5_PERIOD_CODE,
  MT_TIMEFRAME_IDS,
  MT_TIMEFRAME_SECONDS,
  appTimeframeToMt5Seconds,
  isSupportedMtTimeframe,
  mt5SecondsToAppTimeframe
} from './mtBridgeTypes'

describe('mtBridgeTypes timeframe mapping', () => {
  it('maps every supported app timeframe to bar seconds', () => {
    expect(appTimeframeToMt5Seconds('1m')).toBe(60)
    expect(appTimeframeToMt5Seconds('5m')).toBe(300)
    expect(appTimeframeToMt5Seconds('15m')).toBe(900)
    expect(appTimeframeToMt5Seconds('1h')).toBe(3600)
    expect(appTimeframeToMt5Seconds('4h')).toBe(14400)
    expect(appTimeframeToMt5Seconds('1d')).toBe(86400)
  })

  it('round-trips app id ↔ seconds', () => {
    for (const id of MT_TIMEFRAME_IDS) {
      expect(mt5SecondsToAppTimeframe(MT_TIMEFRAME_SECONDS[id])).toBe(id)
    }
  })

  it('rejects unknown timeframes', () => {
    expect(isSupportedMtTimeframe('m30')).toBe(false)
    expect(isSupportedMtTimeframe('w1')).toBe(false)
    expect(isSupportedMtTimeframe('')).toBe(false)
    expect(appTimeframeToMt5Seconds('M15')).toBeNull()
    expect(mt5SecondsToAppTimeframe(1800)).toBeNull()
  })

  it('matches MQL5 ENUM_TIMEFRAMES codes', () => {
    expect(MT5_PERIOD_CODE['1m']).toBe(1)
    expect(MT5_PERIOD_CODE['5m']).toBe(5)
    expect(MT5_PERIOD_CODE['15m']).toBe(15)
    expect(MT5_PERIOD_CODE['1h']).toBe(16385)
    expect(MT5_PERIOD_CODE['4h']).toBe(16388)
    expect(MT5_PERIOD_CODE['1d']).toBe(16408)
  })
})
