import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '@shared/candleUtils'
import type { KlinesFetchParams } from '@shared/klinesTypes'
import { fetchOlderCandles, HISTORY_PAGE_BARS } from './binance'

function candle(time: number): Candle {
  return { time, open: 1, high: 2, low: 0.5, close: 1.5 }
}

/** Stub the preload bridge `fetchKlines` used by the client fetch helpers. */
function stubApi(handler: (params: KlinesFetchParams) => unknown): ReturnType<typeof vi.fn> {
  const fetchKlines = vi.fn(async (params: KlinesFetchParams) => handler(params))
  vi.stubGlobal('window', { api: { fetchKlines } })
  return fetchKlines
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchOlderCandles', () => {
  it('requests the page ending one ms before the oldest loaded candle', async () => {
    const fetchKlines = stubApi(() => ({ ok: true, candles: [candle(500), candle(560)] }))

    const result = await fetchOlderCandles({
      symbol: 'btcusdt',
      interval: '1m',
      beforeTimeSeconds: 600
    })

    expect(result).toEqual([candle(500), candle(560)])
    expect(fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '1m',
      endTime: 600_000 - 1,
      limit: HISTORY_PAGE_BARS
    })
  })

  it('honours an explicit limit', async () => {
    const fetchKlines = stubApi(() => ({ ok: true, candles: [] }))

    await fetchOlderCandles({
      symbol: 'ETHUSDT',
      interval: '15m',
      beforeTimeSeconds: 1_000,
      limit: 250
    })

    expect(fetchKlines).toHaveBeenCalledWith(
      expect.objectContaining({ endTime: 999_999, limit: 250 })
    )
  })

  it('returns nothing for an invalid or non-positive anchor', async () => {
    const fetchKlines = stubApi(() => ({ ok: true, candles: [candle(1)] }))

    expect(
      await fetchOlderCandles({ symbol: 'BTCUSDT', interval: '1m', beforeTimeSeconds: 0 })
    ).toEqual([])
    expect(
      await fetchOlderCandles({ symbol: 'BTCUSDT', interval: '1m', beforeTimeSeconds: Number.NaN })
    ).toEqual([])
    expect(fetchKlines).not.toHaveBeenCalled()
  })

  it('surfaces a fetch error', async () => {
    stubApi(() => ({ ok: false, status: 500, error: 'Failed to load candles (500)' }))

    await expect(
      fetchOlderCandles({ symbol: 'BTCUSDT', interval: '1m', beforeTimeSeconds: 600 })
    ).rejects.toThrow('Failed to load candles (500)')
  })
})
