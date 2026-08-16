import { randomUUID } from 'crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import { WebSocket, WebSocketServer } from 'ws'
import type { Candle } from '@shared/candleUtils'
import {
  MT_BRIDGE_DEFAULT_PORT,
  MT_BRIDGE_HOST,
  MT_HISTORY_CHUNK_LIMIT,
  isSupportedMtTimeframe
} from '@shared/mtBridgeTypes'
import type {
  MtClientInfo,
  MtCommand,
  MtEaHello,
  MtHistoryRequestParams,
  MtHistoryRequestResult,
  MtLiveEvent,
  MtLogEntry,
  MtServerState,
  MtStartResult
} from '@shared/mtBridgeTypes'

const LOG_LIMIT = 200
const HISTORY_TIMEOUT_MS = 15000
const PING_INTERVAL_MS = 15000

type BridgeClient = {
  ws: WebSocket
  info: MtClientInfo
  isAlive: boolean
}

type PendingHistory = {
  resolve: (result: MtHistoryRequestResult) => void
  timer: NodeJS.Timeout
}

let server: WebSocketServer | null = null
let pingTimer: NodeJS.Timeout | null = null
let port = MT_BRIDGE_DEFAULT_PORT

const clients = new Map<string, BridgeClient>()
const pending = new Map<string, PendingHistory>()
const logs: MtLogEntry[] = []

function getUrl(): string {
  return `ws://${MT_BRIDGE_HOST}:${port}`
}

function getState(): MtServerState {
  return {
    running: server != null,
    port,
    url: server != null ? getUrl() : '',
    clients: Array.from(clients.values()).map((client) => client.info),
    logs: [...logs]
  }
}

function broadcastState(): void {
  const state = getState()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('mt:state', state)
  }
}

function emit(event: MtLiveEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('mt:event', event)
  }
}

function addLog(level: MtLogEntry['level'], message: string): void {
  logs.push({ id: randomUUID(), time: Date.now(), level, message })
  if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT)
  broadcastState()
}

function sendToClient(clientId: string, command: MtCommand): boolean {
  const client = clients.get(clientId)
  if (!client || client.ws.readyState !== WebSocket.OPEN) return false
  client.ws.send(JSON.stringify(command))
  return true
}

function firstReadyClientId(): string | null {
  for (const [id, client] of clients) {
    if (client.info.hello && client.ws.readyState === WebSocket.OPEN) return id
  }
  return null
}

function onClientMessage(clientId: string, raw: string): void {
  const client = clients.get(clientId)
  if (!client) return

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    addLog('warn', `Ignored non-JSON message from ${client.info.remoteAddress}.`)
    return
  }

  if (!parsed || typeof parsed !== 'object') return
  const message = parsed as Record<string, unknown>
  const type = String(message.type || '')

  if (type === 'hello') {
    const hello = message as unknown as MtEaHello
    if (hello.app !== 'easy-candle-ea') {
      client.ws.close(1008, 'Not an Easy Candle EA')
      return
    }
    if (client.info.hello) return
    client.info.hello = hello
    addLog(
      'info',
      `EA ready · ${hello.symbol} @ ${hello.server} (${hello.terminal} ${hello.build}${hello.isDemo ? ' · demo' : ''}).`
    )
    emit({ type: 'hello', clientId, hello })
    sendToClient(clientId, { type: 'hello', app: 'easy-candle', version: app.getVersion() })
    return
  }

  if (!client.info.hello) return

  switch (type) {
    case 'tick': {
      const tick = message as unknown as MtTickLike
      if (tick && typeof tick.symbol === 'string') {
        emit({ type: 'tick', clientId, tick: normalizeTick(tick) })
      }
      break
    }
    case 'bar': {
      const bar = message as unknown as MtBarLike
      const normalizedBar = normalizeCandle(bar?.bar)
      if (
        bar &&
        typeof bar.symbol === 'string' &&
        typeof bar.timeframe === 'string' &&
        normalizedBar
      ) {
        emit({
          type: 'bar',
          clientId,
          message: {
            type: 'bar',
            symbol: bar.symbol,
            timeframe: bar.timeframe,
            bar: normalizedBar,
            closed: Boolean(bar.closed)
          }
        })
      }
      break
    }
    case 'candles': {
      const candles = message as unknown as MtCandlesLike
      const requestId = String(candles?.requestId || '')
      const normalized = {
        type: 'candles' as const,
        symbol: String(candles?.symbol || ''),
        timeframe: String(candles?.timeframe || ''),
        from: Number(candles?.from) || 0,
        to: Number(candles?.to) || 0,
        requestId,
        candles: Array.isArray(candles?.candles)
          ? candles.candles.map(normalizeCandle).filter((c): c is Candle => c != null)
          : []
      }
      const entry = pending.get(requestId)
      if (entry && normalized.candles.length > 0) {
        clearTimeout(entry.timer)
        pending.delete(requestId)
        entry.resolve({
          ok: true,
          requestId,
          symbol: normalized.symbol,
          timeframe: normalized.timeframe,
          from: normalized.from,
          to: normalized.to,
          candles: normalized.candles
        })
      }
      emit({ type: 'candles', clientId, message: normalized })
      break
    }
    case 'error': {
      const err = message as unknown as MtErrorLike
      const code = String(err?.code || 'error')
      const errorMessage = String(err?.message || 'Unknown EA error')
      addLog('warn', `EA: ${errorMessage}`)
      emit({ type: 'error', clientId, code, message: errorMessage })
      break
    }
    case 'pong':
      break
    default:
      break
  }
}

type MtTickLike = Record<string, unknown>
type MtBarLike = Record<string, unknown> & { bar?: unknown }
type MtCandlesLike = Record<string, unknown> & { candles?: unknown }
type MtErrorLike = { code?: unknown; message?: unknown }
type MtCandleWire = {
  t?: unknown
  o?: unknown
  h?: unknown
  l?: unknown
  c?: unknown
  v?: unknown
}

function normalizeTick(tick: MtTickLike): MtTickNormalized {
  return {
    type: 'tick',
    symbol: String(tick.symbol || ''),
    time: Math.floor(Number(tick.time) || 0),
    bid: Number(tick.bid) || 0,
    ask: Number(tick.ask) || 0,
    last: Number(tick.last) || 0,
    volume: Number(tick.volume) || 0
  }
}

type MtTickNormalized = {
  type: 'tick'
  symbol: string
  time: number
  bid: number
  ask: number
  last: number
  volume: number
}

function normalizeCandle(value: unknown): Candle | null {
  if (!value || typeof value !== 'object') return null
  const c = value as MtCandleWire
  const time = Math.floor(Number(c.t))
  const open = Number(c.o)
  const high = Number(c.h)
  const low = Number(c.l)
  const close = Number(c.c)
  if (![time, open, high, low, close].every(Number.isFinite)) return null
  const candle: Candle = { time, open, high, low, close }
  const volume = Number(c.v)
  if (Number.isFinite(volume)) candle.volume = volume
  return candle
}

function onClientConnect(ws: WebSocket): void {
  const id = randomUUID()
  const socket = ws as WebSocket & { _socket?: { remoteAddress?: string } }
  const rawAddress = socket._socket?.remoteAddress || MT_BRIDGE_HOST
  const remoteAddress = rawAddress.replace(/^::ffff:/, '')
  const info: MtClientInfo = {
    id,
    connectedAt: Date.now(),
    remoteAddress,
    hello: null
  }
  clients.set(id, { ws, info, isAlive: true })

  addLog('info', `MetaTrader connected from ${remoteAddress}.`)
  emit({ type: 'connection', clientId: id, remoteAddress })

  ws.on('message', (data) => {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
    onClientMessage(id, raw)
  })
  ws.on('pong', () => {
    const client = clients.get(id)
    if (client) client.isAlive = true
  })
  ws.on('close', () => onClientDisconnect(id))
  ws.on('error', (err) => {
    addLog('error', `Socket error: ${err.message}`)
  })
}

function onClientDisconnect(id: string): void {
  const client = clients.get(id)
  if (!client) return
  clients.delete(id)
  addLog(
    'info',
    `MetaTrader disconnected (${client.info.hello ? client.info.hello.symbol : 'no hello'}).`
  )
  emit({ type: 'disconnection', clientId: id })
  for (const [requestId, entry] of pending) {
    if (!entry) continue
    clearTimeout(entry.timer)
    pending.delete(requestId)
    entry.resolve({ ok: false, requestId, error: 'MetaTrader disconnected before responding.' })
  }
}

function startServer(requestedPort: number): Promise<MtStartResult> {
  if (server) return Promise.resolve({ ok: true, url: getUrl() })

  const requested = Math.floor(Number(requestedPort) || MT_BRIDGE_DEFAULT_PORT)
  if (requested < 1 || requested > 65535) {
    return Promise.resolve({ ok: false, error: 'Port must be between 1 and 65535.' })
  }

  return new Promise<MtStartResult>((resolve) => {
    const srv = new WebSocketServer({ host: MT_BRIDGE_HOST, port: requested })
    server = srv

    srv.on('listening', () => {
      port = requested
      addLog('info', `Bridge server listening on ${getUrl()} (localhost only).`)
      pingTimer = setInterval(() => {
        for (const client of clients.values()) {
          if (client.ws.readyState !== WebSocket.OPEN) continue
          if (!client.isAlive) {
            client.ws.terminate()
            continue
          }
          client.isAlive = false
          client.ws.ping()
        }
      }, PING_INTERVAL_MS)
      resolve({ ok: true, url: getUrl() })
    })

    srv.on('error', (err) => {
      if (server === srv) server = null
      addLog('error', `Server error: ${err.message}`)
      resolve({ ok: false, error: err.message })
    })

    srv.on('connection', onClientConnect)
  })
}

function stopServer(): void {
  if (!server) return
  const srv = server
  server = null
  if (pingTimer != null) {
    clearInterval(pingTimer)
    pingTimer = null
  }
  for (const [id, client] of clients) {
    try {
      client.ws.close(1001, 'Server stopping')
    } catch {
      // ignore
    }
    clients.delete(id)
  }
  for (const [requestId, entry] of pending) {
    clearTimeout(entry.timer)
    pending.delete(requestId)
    entry.resolve({ ok: false, requestId, error: 'Bridge server stopped.' })
  }
  try {
    srv.close()
  } catch {
    // ignore
  }
  addLog('info', 'Bridge server stopped.')
}

async function requestHistory(params: MtHistoryRequestParams): Promise<MtHistoryRequestResult> {
  const symbol = String(params?.symbol || '').toUpperCase()
  const timeframe = String(params?.timeframe || '')
  const from = Math.floor(Number(params?.from) || 0)
  const to = Math.floor(Number(params?.to) || 0)

  if (!symbol) {
    return { ok: false, requestId: '', error: 'Symbol is required.' }
  }
  if (!isSupportedMtTimeframe(timeframe)) {
    return { ok: false, requestId: '', error: 'Unsupported timeframe.' }
  }
  if (from <= 0 || to <= from) {
    return { ok: false, requestId: '', error: 'Invalid time range (from must be before to).' }
  }

  const limit = Math.min(
    MT_HISTORY_CHUNK_LIMIT,
    Math.max(1, Math.floor(Number(params?.limit) || MT_HISTORY_CHUNK_LIMIT))
  )
  const requestId = `mt-${randomUUID()}`

  const target =
    params.clientId && clients.has(params.clientId) ? params.clientId : firstReadyClientId()
  if (!target) {
    return { ok: false, requestId, error: 'No MetaTrader EA connected.' }
  }
  if (
    !sendToClient(target, { type: 'requestHistory', symbol, timeframe, from, to, limit, requestId })
  ) {
    return { ok: false, requestId, error: 'MetaTrader connection lost.' }
  }

  return new Promise<MtHistoryRequestResult>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return
      pending.delete(requestId)
      resolve({ ok: false, requestId, error: 'Timed out waiting for MetaTrader.' })
    }, HISTORY_TIMEOUT_MS)
    pending.set(requestId, { resolve, timer })
  })
}

function setLive(clientId: string | undefined, live: boolean): void {
  const target = clientId && clients.has(clientId) ? clientId : firstReadyClientId()
  if (target) sendToClient(target, { type: 'setLive', live: Boolean(live) })
}

export function registerMtBridgeIpc(): void {
  ipcMain.handle('mt:getState', (): MtServerState => getState())
  ipcMain.handle('mt:start', (_event, portValue: number): Promise<MtStartResult> =>
    startServer(portValue)
  )
  ipcMain.handle('mt:stop', (): void => stopServer())
  ipcMain.handle(
    'mt:requestHistory',
    (_event, params: MtHistoryRequestParams): Promise<MtHistoryRequestResult> =>
      requestHistory(params)
  )
  ipcMain.handle('mt:setLive', (_event, clientId: string | undefined, live: boolean): void =>
    setLive(clientId, live)
  )
  ipcMain.handle('mt:clearLogs', (): void => {
    logs.length = 0
    broadcastState()
  })
}

export function stopMtBridgeForQuit(): void {
  stopServer()
}
