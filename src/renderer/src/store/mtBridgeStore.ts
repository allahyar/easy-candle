import { create } from 'zustand'
import type { Candle } from '@shared/candleUtils'
import type {
  MtHistoryRequestParams,
  MtHistoryRequestResult,
  MtServerState
} from '@shared/mtBridgeTypes'

export type MtLiveTick = {
  symbol: string
  time: number
  bid: number
  ask: number
  last: number
  volume: number
}

export type MtLiveBar = {
  symbol: string
  timeframe: string
  bar: Candle
  closed: boolean
  at: number
}

type MtBridgeState = {
  /** Server + client state, refreshed on every main-process broadcast. */
  server: MtServerState | null
  /** Latest tick per symbol. */
  ticks: Record<string, MtLiveTick>
  /** Latest bar per `symbol|timeframe`. */
  bars: Record<string, MtLiveBar>
  /** Recent lifecycle events and bar closes (ticks excluded). */
  activity: string[]
  /** True after the store subscribed to main-process events. */
  initialized: boolean
  init: () => void
  refresh: () => Promise<void>
  startServer: (port: number) => Promise<MtStartResult>
  stopServer: () => Promise<void>
  requestHistory: (params: MtHistoryRequestParams) => Promise<MtHistoryRequestResult>
  setLive: (clientId: string | undefined, live: boolean) => Promise<void>
  clearLogs: () => Promise<void>
  clearFeed: () => void
}

type MtStartResult = { ok: true; url: string } | { ok: false; error: string }

const ACTIVITY_LIMIT = 100

let wired = false

function formatUtc(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '—'
  const d = new Date(epochSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function pushActivity(list: string[], entry: string): string[] {
  const next = [...list, entry]
  return next.length > ACTIVITY_LIMIT ? next.slice(next.length - ACTIVITY_LIMIT) : next
}

export const useMtBridgeStore = create<MtBridgeState>((set, get) => ({
  server: null,
  ticks: {},
  bars: {},
  activity: [],
  initialized: false,

  init() {
    if (wired) return
    wired = true
    void get().refresh()

    window.api.mtBridge.onState((server) => set({ server }))

    window.api.mtBridge.onEvent((event) => {
      const state = get()
      switch (event.type) {
        case 'tick': {
          const tick = event.tick
          set({ ticks: { ...state.ticks, [tick.symbol]: tick } })
          break
        }
        case 'bar': {
          const { symbol, timeframe, bar, closed } = event.message
          const key = `${symbol}|${timeframe}`
          set({
            bars: { ...state.bars, [key]: { symbol, timeframe, bar, closed, at: Date.now() } },
            activity: pushActivity(
              state.activity,
              closed
                ? `${formatUtc(bar.time)} · ${symbol} ${timeframe} bar closed (${bar.close})`
                : `${formatUtc(bar.time)} · ${symbol} ${timeframe} bar update (${bar.close})`
            )
          })
          break
        }
        case 'connection':
          set({ activity: pushActivity(state.activity, `EA connected (${event.remoteAddress})`) })
          break
        case 'disconnection':
          set({ activity: pushActivity(state.activity, 'EA disconnected') })
          break
        case 'hello':
          set({
            activity: pushActivity(
              state.activity,
              `EA ready · ${event.hello.symbol} @ ${event.hello.server}`
            )
          })
          break
        case 'error':
          set({ activity: pushActivity(state.activity, `EA error: ${event.message}`) })
          break
        case 'candles':
          break
      }
    })
  },

  async refresh() {
    const server = await window.api.mtBridge.getState()
    set({ server })
  },

  async startServer(port) {
    return window.api.mtBridge.startServer(port)
  },

  async stopServer() {
    await window.api.mtBridge.stopServer()
    set({ ticks: {}, bars: {} })
    await get().refresh()
  },

  async requestHistory(params) {
    return window.api.mtBridge.requestHistory(params)
  },

  async setLive(clientId, live) {
    await window.api.mtBridge.setLive(clientId, live)
  },

  async clearLogs() {
    await window.api.mtBridge.clearLogs()
    await get().refresh()
  },

  clearFeed() {
    set({ ticks: {}, bars: {}, activity: [] })
  }
}))

export { formatUtc }
