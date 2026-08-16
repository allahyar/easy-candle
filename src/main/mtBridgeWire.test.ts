import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import net from 'node:net'
import crypto from 'node:crypto'
import type { MtHistoryRequestResult, MtLiveEvent, MtServerState } from '@shared/mtBridgeTypes'

// ---------------------------------------------------------------------------
// Electron is mocked so the real mtBridge server code can run inside vitest.
// BrowserWindow.getAllWindows() returns one fake window whose webContents.send
// captures the events/states the server pushes to the renderer.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  ipcHandlers: {} as Record<string, (...args: unknown[]) => unknown>,
  sentEvents: [] as MtLiveEvent[],
  sentStates: [] as MtServerState[]
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9-test'
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown): void => {
            if (channel === 'mt:event') mocks.sentEvents.push(payload as MtLiveEvent)
            else if (channel === 'mt:state') mocks.sentStates.push(payload as MtServerState)
          }
        }
      }
    ]
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      mocks.ipcHandlers[channel] = fn
    }
  }
}))

import { registerMtBridgeIpc, stopMtBridgeForQuit } from './mtBridge'

// ---------------------------------------------------------------------------
// Raw RFC 6455 client that reproduces the framing of EasyCandleBridge.mq5:
//  * manual HTTP Upgrade handshake with a random base64 Sec-WebSocket-Key
//  * client -> server frames are MASKED (as RFC 6455 requires for clients)
//  * server -> client frames are unmasked
// ---------------------------------------------------------------------------
function generateWsKey(): string {
  return crypto.randomBytes(16).toString('base64')
}

function buildFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  let header: Buffer
  if (payload.length <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length <= 65535) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.from(payload)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([header, mask, masked])
}

type Frame = { opcode: number; payload: Buffer }

class RawWsClient {
  private socket: net.Socket | null = null
  private buffer = Buffer.alloc(0)
  private handshakeDone = false
  private messages: string[] = []
  private waiters: Array<{ resolve: (msg: string) => void; reject: (err: Error) => void }> = []
  private connectResolve: (() => void) | null = null
  private connectReject: ((err: Error) => void) | null = null

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      const socket = net.connect(port, host)
      this.socket = socket
      socket.setNoDelay(true)
      socket.on('data', (chunk: Buffer) => this.onData(chunk))
      socket.on('error', (err) => {
        this.connectReject?.(err)
        for (const w of this.waiters) w.reject(err)
        this.waiters = []
      })
      socket.on('close', () => {
        const err = new Error('socket closed')
        for (const w of this.waiters) w.reject(err)
        this.waiters = []
      })
      socket.on('connect', () => {
        const key = generateWsKey()
        const request =
          `GET / HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`
        socket.write(request, 'latin1')
      })
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.handshakeDone) {
      const idx = this.buffer.indexOf('\r\n\r\n')
      if (idx >= 0) {
        const header = this.buffer.subarray(0, idx + 4).toString('latin1')
        this.buffer = this.buffer.subarray(idx + 4)
        this.handshakeDone = true
        if (header.includes(' 101 ')) {
          this.connectResolve?.()
        } else {
          this.connectReject?.(new Error(`handshake rejected: ${header.split('\r\n')[0]}`))
        }
      }
    }
    this.drainFrames()
  }

  private drainFrames(): void {
    for (;;) {
      const frame = this.tryParseFrame()
      if (!frame) break
      if (frame.opcode === 0x9) {
        // server ping -> pong (same as the EA's WsSendFrame(WS_OP_PONG, ""))
        this.socket?.write(buildFrame('', 0xa))
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        const msg = frame.payload.toString('utf8')
        const waiter = this.waiters.shift()
        if (waiter) waiter.resolve(msg)
        else this.messages.push(msg)
      } else if (frame.opcode === 0x8) {
        this.socket?.end()
      }
    }
  }

  private tryParseFrame(): Frame | null {
    if (this.buffer.length < 2) return null
    const opcode = this.buffer[0] & 0x0f
    const masked = (this.buffer[1] & 0x80) !== 0
    let len = this.buffer[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (this.buffer.length < 4) return null
      len = this.buffer.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (this.buffer.length < 10) return null
      len = Number(this.buffer.readBigUInt64BE(2))
      offset = 10
    }
    let mask: Buffer | null = null
    if (masked) {
      if (this.buffer.length < offset + 4) return null
      mask = this.buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (this.buffer.length < offset + len) return null
    let payload = this.buffer.subarray(offset, offset + len)
    if (mask) {
      const unmasked = Buffer.alloc(len)
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i & 3]
      payload = unmasked
    }
    this.buffer = this.buffer.subarray(offset + len)
    return { opcode, payload }
  }

  nextMessage(): Promise<string> {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift() as string)
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  sendText(text: string): void {
    this.socket?.write(buildFrame(text, 0x1))
  }

  close(): void {
    this.socket?.end()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close()
        reject(new Error('no address'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

async function startServerOnFreePort(): Promise<number> {
  const start = mocks.ipcHandlers['mt:start'] as (...args: unknown[]) => unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await getFreePort()
    const result = (await start(undefined, port)) as { ok: boolean }
    if (result.ok) return port
  }
  throw new Error('failed to start bridge server on a free port')
}

function eaHello(symbol = 'EURUSD'): string {
  return JSON.stringify({
    type: 'hello',
    app: 'easy-candle-ea',
    version: '1.00',
    terminal: 'MT5',
    build: '5000',
    account: '12345',
    server: 'TestServer',
    company: 'Test Ltd',
    symbol,
    timeframe: '1m',
    digits: 5,
    isDemo: true
  })
}

async function waitFor(fn: () => void, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      fn()
      return
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MetaTrader bridge — WebSocket communication', () => {
  let port: number

  beforeAll(() => {
    registerMtBridgeIpc()
  })

  beforeEach(async () => {
    stopMtBridgeForQuit()
    mocks.sentEvents.length = 0
    mocks.sentStates.length = 0
    port = await startServerOnFreePort()
  })

  afterEach(() => {
    stopMtBridgeForQuit()
  })

  it('accepts an RFC 6455 client using the exact framing of the MQL5 EA and completes the hello round trip', async () => {
    const client = new RawWsClient()
    await client.connect('127.0.0.1', port)

    client.sendText(eaHello())

    const reply = JSON.parse(await client.nextMessage()) as Record<string, unknown>
    expect(reply.type).toBe('hello')
    expect(reply.app).toBe('easy-candle')
    expect(reply.version).toBe('9.9.9-test')

    // The EA is now registered on the server side.
    await waitFor(() => {
      expect(mocks.sentStates.some((s) => s.clients.some((c) => c.hello != null))).toBe(true)
    })
    client.close()
  })

  it('closes the connection when a client does not identify as an Easy Candle EA', async () => {
    const client = new RawWsClient()
    await client.connect('127.0.0.1', port)

    client.sendText(JSON.stringify({ type: 'hello', app: 'some-other-ea' }))

    await expect(client.nextMessage()).rejects.toThrow(/closed|error/)
    client.close()
  })

  it('runs a full requestHistory round trip (server command -> EA candles -> normalized result)', async () => {
    const client = new RawWsClient()
    await client.connect('127.0.0.1', port)
    client.sendText(eaHello())
    await client.nextMessage() // app hello reply

    const now = Math.floor(Date.now() / 1000)
    const from = now - 120
    const to = now
    const requestHistory = mocks.ipcHandlers['mt:requestHistory'] as (...args: unknown[]) => unknown
    const resultPromise = requestHistory(undefined, {
      symbol: 'EURUSD',
      timeframe: '1m',
      from,
      to
    }) as Promise<MtHistoryRequestResult>

    const command = JSON.parse(await client.nextMessage()) as Record<string, unknown>
    expect(command.type).toBe('requestHistory')
    expect(command.symbol).toBe('EURUSD')
    expect(command.timeframe).toBe('1m')
    expect(command.requestId).toBeTruthy()

    // Reply exactly like HandleHistoryRequest() in EasyCandleBridge.mq5.
    client.sendText(
      JSON.stringify({
        type: 'candles',
        symbol: 'EURUSD',
        timeframe: '1m',
        from,
        to,
        requestId: command.requestId,
        candles: [
          { t: from, o: '1.10000', h: '1.10100', l: '1.09900', c: '1.10050', v: '120' },
          { t: from + 60, o: '1.10050', h: '1.10200', l: '1.10000', c: '1.10150', v: '80' }
        ]
      })
    )

    const result = await resultPromise
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.requestId).toBe(command.requestId)
      expect(result.candles).toHaveLength(2)
      expect(result.candles[0]).toEqual({
        time: from,
        open: 1.1,
        high: 1.101,
        low: 1.099,
        close: 1.1005,
        volume: 120
      })
    }

    // The raw candles payload also surfaces as a renderer event.
    await waitFor(() => {
      expect(mocks.sentEvents.some((e) => e.type === 'candles')).toBe(true)
    })
    client.close()
  })

  it('emits normalized live tick and bar events to the renderer', async () => {
    const client = new RawWsClient()
    await client.connect('127.0.0.1', port)
    client.sendText(eaHello())
    await client.nextMessage() // app hello reply

    client.sendText(
      JSON.stringify({
        type: 'tick',
        symbol: 'EURUSD',
        time: 1700000000,
        bid: '1.10000',
        ask: '1.10002',
        last: '1.10001',
        volume: '5'
      })
    )
    client.sendText(
      JSON.stringify({
        type: 'bar',
        symbol: 'EURUSD',
        timeframe: '1m',
        closed: false,
        bar: { t: 1700000000, o: '1.10000', h: '1.10100', l: '1.09900', c: '1.10050', v: '120' }
      })
    )

    await waitFor(() => {
      const ticks = mocks.sentEvents.filter((e) => e.type === 'tick')
      const bars = mocks.sentEvents.filter((e) => e.type === 'bar')
      expect(ticks).toHaveLength(1)
      expect(bars).toHaveLength(1)
      const tick = ticks[0]
      const bar = bars[0]
      expect(tick.type).toBe('tick')
      expect(tick.tick.bid).toBe(1.1)
      expect(tick.tick.ask).toBe(1.10002)
      expect(bar.type).toBe('bar')
      expect(bar.message.bar).toEqual({
        time: 1700000000,
        open: 1.1,
        high: 1.101,
        low: 1.099,
        close: 1.1005,
        volume: 120
      })
    })
    client.close()
  })

  it('fails fast when requesting history with no EA connected', async () => {
    const requestHistory = mocks.ipcHandlers['mt:requestHistory'] as (...args: unknown[]) => unknown
    const result = (await requestHistory(undefined, {
      symbol: 'EURUSD',
      timeframe: '1m',
      from: 1700000000,
      to: 1700000060
    })) as MtHistoryRequestResult
    expect(result.ok).toBe(false)
  })
})
