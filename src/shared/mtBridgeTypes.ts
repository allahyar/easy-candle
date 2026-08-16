import type { Candle } from './candleUtils'

/**
 * Protocol shared between the Electron main process (WebSocket server) and the
 * MetaTrader 5 Expert Advisor (mt5/EasyCandleBridge.mq5).
 *
 * Frames are compact JSON text messages. Candles use the app's `Candle` shape
 * (UTC seconds, `t/o/h/l/c/v` in the wire format).
 */

export const MT_BRIDGE_DEFAULT_PORT = 8787
export const MT_BRIDGE_HOST = '127.0.0.1'
/** Max bars returned by the EA for a single history request (app paginates). */
export const MT_HISTORY_CHUNK_LIMIT = 5000
/** Safety cap the EA applies on top of the requested limit. */
export const MT_HISTORY_EA_CAP = 200000

export type MtTimeframeId = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

/** App timeframe ids the MT bridge supports (subset of the app timeframes). */
export const MT_TIMEFRAME_IDS: MtTimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/** App timeframe id -> bar length in seconds. */
export const MT_TIMEFRAME_SECONDS: Record<MtTimeframeId, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400
}

/** MQL5 ENUM_TIMEFRAMES numeric codes used to assert wire compatibility. */
export const MT5_PERIOD_CODE: Record<MtTimeframeId, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 16385,
  '4h': 16388,
  '1d': 16408
}

const SECONDS_TO_ID = new Map<number, MtTimeframeId>(
  MT_TIMEFRAME_IDS.map((id) => [MT_TIMEFRAME_SECONDS[id], id])
)

export function isSupportedMtTimeframe(value: unknown): value is MtTimeframeId {
  return typeof value === 'string' && value in MT_TIMEFRAME_SECONDS
}

export function mt5SecondsToAppTimeframe(seconds: number): MtTimeframeId | null {
  return SECONDS_TO_ID.get(seconds) ?? null
}

export function appTimeframeToMt5Seconds(id: string): number | null {
  return isSupportedMtTimeframe(id) ? MT_TIMEFRAME_SECONDS[id] : null
}

/** EA → app: identifies the connected terminal. */
export type MtEaHello = {
  type: 'hello'
  app: 'easy-candle-ea'
  version: string
  terminal: string
  build: string
  account: string
  server: string
  company: string
  /** Symbol of the chart the EA is attached to. */
  symbol: string
  /** Chart timeframe as an app id (1m/5m/…). */
  timeframe: string
  digits: number
  isDemo: boolean
}

export type MtCandle = Candle

/** EA → app: a batch of historical candles for a `requestHistory` reply. */
export type MtCandlesMessage = {
  type: 'candles'
  symbol: string
  timeframe: string
  from: number
  to: number
  requestId: string
  candles: Candle[]
}

/** EA → app: live bar. `closed` marks a bar that just finished forming. */
export type MtBarMessage = {
  type: 'bar'
  symbol: string
  timeframe: string
  bar: Candle
  closed: boolean
}

/** EA → app: real-time quote for the chart symbol. */
export type MtTickMessage = {
  type: 'tick'
  symbol: string
  time: number
  bid: number
  ask: number
  last: number
  volume: number
}

export type MtErrorMessage = {
  type: 'error'
  code: string
  message: string
  symbol?: string
}

export type MtPongMessage = { type: 'pong' }

/** Messages the EA sends to the app. */
export type MtEaMessage =
  MtEaHello | MtCandlesMessage | MtBarMessage | MtTickMessage | MtErrorMessage | MtPongMessage

/** App → EA commands. */
export type MtCommand =
  | { type: 'hello'; app: 'easy-candle'; version: string }
  | { type: 'ping' }
  | {
      type: 'requestHistory'
      symbol: string
      timeframe: string
      from: number
      to: number
      limit: number
      requestId: string
    }
  | { type: 'setLive'; live: boolean }

export type MtStartResult = { ok: true; url: string } | { ok: false; error: string }

export type MtLogLevel = 'info' | 'warn' | 'error'

export type MtLogEntry = {
  id: string
  time: number
  level: MtLogLevel
  message: string
}

export type MtClientInfo = {
  id: string
  connectedAt: number
  remoteAddress: string
  hello: MtEaHello | null
}

export type MtServerState = {
  running: boolean
  port: number
  url: string
  clients: MtClientInfo[]
  logs: MtLogEntry[]
}

export type MtHistoryRequestParams = {
  /** Optional EA client to target; defaults to the first connected one. */
  clientId?: string
  symbol: string
  timeframe: string
  from: number
  to: number
  limit?: number
}

export type MtHistoryRequestResult =
  | {
      ok: true
      requestId: string
      symbol: string
      timeframe: string
      from: number
      to: number
      candles: Candle[]
    }
  | { ok: false; requestId: string; error: string }

/** Live events relayed from the main process to the renderer. */
export type MtLiveEvent =
  | { type: 'connection'; clientId: string; remoteAddress: string }
  | { type: 'disconnection'; clientId: string }
  | { type: 'hello'; clientId: string; hello: MtEaHello }
  | { type: 'tick'; clientId: string; tick: MtTickMessage }
  | { type: 'bar'; clientId: string; message: MtBarMessage }
  | { type: 'candles'; clientId: string; message: MtCandlesMessage }
  | { type: 'error'; clientId: string; code: string; message: string }
