import { describe, expect, it } from 'vitest'
import type { ImportedDatasetMeta } from './importTypes'
import { importedCoverage, liveCoverage, validateReplayStart } from './replayCoverage'

function meta(overrides: Partial<ImportedDatasetMeta> = {}): ImportedDatasetMeta {
  return {
    id: 'imp-1',
    symbol: 'EURUSD',
    sourceTimeframe: '1m',
    timeframe: '15m',
    originalFileName: 'EURUSD.csv',
    candleCount: 5000,
    firstTime: 1_000,
    lastTime: 301_000,
    timeframes: {
      '1m': { candleCount: 5000, firstTime: 1_000, lastTime: 301_000 },
      '15m': { candleCount: 334, firstTime: 1_800, lastTime: 300_600 }
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    origin: 'csv',
    ...overrides
  }
}

describe('importedCoverage', () => {
  it('returns empty coverage without metadata', () => {
    expect(importedCoverage(null, '15m')).toEqual({
      kind: 'imported',
      firstTime: 0,
      lastTime: 0,
      count: 0
    })
  })

  it('reads per-timeframe stats', () => {
    expect(importedCoverage(meta(), '15m')).toEqual({
      kind: 'imported',
      firstTime: 1_800,
      lastTime: 300_600,
      count: 334
    })
  })

  it('falls back to dataset bounds for an unknown timeframe', () => {
    expect(importedCoverage(meta(), '4h')).toEqual({
      kind: 'imported',
      firstTime: 1_000,
      lastTime: 301_000,
      count: 5000
    })
  })

  it('clamps negative or non-finite bounds to zero', () => {
    const coverage = importedCoverage(
      meta({
        timeframes: {
          '15m': {
            candleCount: Number.NaN,
            firstTime: -5,
            lastTime: Number.POSITIVE_INFINITY
          }
        }
      }),
      '15m'
    )
    expect(coverage).toEqual({ kind: 'imported', firstTime: 0, lastTime: 0, count: 0 })
  })
})

describe('liveCoverage', () => {
  it('leaves history unbounded and caps at now', () => {
    expect(liveCoverage(1_700_000_000)).toEqual({
      kind: 'live',
      firstTime: 0,
      lastTime: 1_700_000_000,
      count: 0
    })
  })
})

describe('validateReplayStart', () => {
  const imported = importedCoverage(meta(), '15m')

  it('accepts a time inside imported coverage', () => {
    expect(validateReplayStart(150_000, imported)).toBeNull()
  })

  it('accepts the last imported candle open', () => {
    expect(validateReplayStart(imported.lastTime, imported)).toBeNull()
  })

  it('rejects a time before imported coverage', () => {
    expect(validateReplayStart(1_000, imported)).toBe(
      'Selected time is before the start of the imported data.'
    )
  })

  it('rejects a time after imported coverage', () => {
    expect(validateReplayStart(300_601, imported)).toBe(
      'Selected time is after the end of the imported data.'
    )
  })

  it('rejects now or later on a live feed', () => {
    const live = liveCoverage(1_700_000_000)
    expect(validateReplayStart(1_700_000_000, live)).toBe('Start time must be in the past (UTC).')
    expect(validateReplayStart(1_699_999_999, live)).toBeNull()
  })

  it('uses the subject in live-feed messages', () => {
    const live = liveCoverage(1_700_000_000)
    expect(validateReplayStart(1_700_000_001, live, { subject: 'Jump time' })).toBe(
      'Jump time must be in the past (UTC).'
    )
  })

  it('rejects non-finite times', () => {
    expect(validateReplayStart(Number.NaN, imported)).toBe('Invalid start time.')
    expect(validateReplayStart(Number.NaN, imported, { subject: 'Jump time' })).toBe(
      'Invalid jump time.'
    )
  })

  it('ignores unknown (zero) bounds', () => {
    const unknown = importedCoverage(null, '15m')
    expect(validateReplayStart(150_000, unknown)).toBeNull()
  })
})
