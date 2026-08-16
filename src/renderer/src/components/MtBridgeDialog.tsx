import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Activity, Cable, Download, Pause, Play, Plug, X } from 'lucide-react'
import IconButton from '@/components/IconButton'
import type { ImportFeedback } from '@/components/ImportDataDialog'
import { buildImportTimeframes } from '@shared/candleAggregate'
import { dedupeCandlesByTime, type Candle } from '@shared/candleUtils'
import {
  MT_BRIDGE_DEFAULT_PORT,
  MT_HISTORY_CHUNK_LIMIT,
  MT_TIMEFRAME_IDS,
  MT_TIMEFRAME_SECONDS
} from '@shared/mtBridgeTypes'
import { alignTimeToInterval } from '@shared/timeframes'
import { formatUtc, useMtBridgeStore } from '@/store/mtBridgeStore'
import { useReplayStore } from '@/store/replayStore'
import { useUiLayoutStore } from '@/store/uiLayoutStore'

type MtBridgeDialogProps = {
  onFeedback?: (feedback: ImportFeedback | null) => void
}

type InlineMessage = { tone: 'error' | 'info' | 'success'; message: string } | null

function epochToLocalInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`
}

/** Interpret the datetime-local wall-clock as UTC (the app is UTC-based). */
function localInputToUtc(value: string): number {
  if (!value) return 0
  const [datePart, timePart] = value.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = (timePart || '00:00').split(':').map(Number)
  if (![y, mo, d].every(Number.isFinite)) return 0
  return Math.floor(Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0) / 1000)
}

const inputClass =
  'h-8 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200 outline-none focus:border-amber-500/70'

export default function MtBridgeDialog({ onFeedback }: MtBridgeDialogProps): ReactNode {
  const open = useUiLayoutStore((s) => s.mtBridgeDialogOpen)
  const setOpen = useUiLayoutStore((s) => s.setMtBridgeDialogOpen)
  const server = useMtBridgeStore((s) => s.server)
  const ticks = useMtBridgeStore((s) => s.ticks)
  const bars = useMtBridgeStore((s) => s.bars)
  const activity = useMtBridgeStore((s) => s.activity)
  const activateImportedDataset = useReplayStore((s) => s.activateImportedDataset)

  const [port, setPort] = useState(String(MT_BRIDGE_DEFAULT_PORT))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<InlineMessage>(null)
  const [paused, setPaused] = useState<Record<string, boolean>>({})
  const [symbol, setSymbol] = useState('')
  const [timeframe, setTimeframe] = useState('1m')
  const [fromStr, setFromStr] = useState('')
  const [toStr, setToStr] = useState('')
  const [historyCandles, setHistoryCandles] = useState<Candle[]>([])
  const [historyInfo, setHistoryInfo] = useState('')

  const running = Boolean(server?.running)
  const clients = server?.clients ?? []
  const eaClients = clients.filter((client) => client.hello)

  const showInline = useCallback((tone: NonNullable<InlineMessage>['tone'], text: string): void => {
    setMessage({ tone, message: text })
  }, [])

  useEffect(() => {
    useMtBridgeStore.getState().init()
  }, [])

  useEffect(() => {
    if (!open) return undefined
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, setOpen])

  async function onToggleServer(): Promise<void> {
    setMessage(null)
    if (running) {
      await useMtBridgeStore.getState().stopServer()
      setPaused({})
      setPort(String(useMtBridgeStore.getState().server?.port || MT_BRIDGE_DEFAULT_PORT))
      showInline('info', 'Bridge server stopped.')
      return
    }
    setBusy(true)
    try {
      const result = await useMtBridgeStore.getState().startServer(Number(port))
      if (result.ok) {
        showInline('success', `Bridge listening on ${result.url} (localhost only).`)
      } else {
        showInline('error', result.error)
      }
    } finally {
      setBusy(false)
    }
  }

  async function onTogglePause(clientId: string): Promise<void> {
    const next = !paused[clientId]
    setPaused((prev) => ({ ...prev, [clientId]: next }))
    await useMtBridgeStore.getState().setLive(clientId, !next)
    showInline('info', next ? 'Live feed paused for this EA.' : 'Live feed resumed.')
  }

  async function onFetchHistory(): Promise<void> {
    const sym = symbol.trim().toUpperCase()
    const from = localInputToUtc(fromStr)
    const to = localInputToUtc(toStr)
    if (!sym) {
      showInline('error', 'Enter a symbol.')
      return
    }
    if (to <= from) {
      showInline('error', 'To must be after From (UTC).')
      return
    }
    const target = eaClients[0]?.id
    if (!target) {
      showInline('error', 'No MetaTrader EA is connected yet.')
      return
    }

    setBusy(true)
    setMessage(null)
    setHistoryCandles([])
    setHistoryInfo('')

    const tfSeconds = MT_TIMEFRAME_SECONDS[timeframe as keyof typeof MT_TIMEFRAME_SECONDS]
    const collected: Candle[] = []
    let cursor = alignTimeToInterval(from, tfSeconds)
    let pages = 0
    const maxPages = 2000

    try {
      while (cursor < to && pages < maxPages) {
        pages += 1
        const res = await useMtBridgeStore.getState().requestHistory({
          clientId: target,
          symbol: sym,
          timeframe,
          from: cursor,
          to,
          limit: MT_HISTORY_CHUNK_LIMIT
        })
        if (!res.ok) {
          if (collected.length === 0) {
            showInline('error', res.error)
          } else {
            setHistoryInfo(
              `${res.error} — keeping the ${collected.length.toLocaleString()} rows fetched so far.`
            )
          }
          break
        }
        collected.push(...res.candles)
        setHistoryInfo(`Fetched ${collected.length.toLocaleString()} candles…`)
        if (res.candles.length === 0) break
        const lastT = res.candles[res.candles.length - 1].time
        if (lastT >= to) break
        cursor = lastT + 1
      }

      const deduped = dedupeCandlesByTime(collected)
      setHistoryCandles(deduped)
      if (deduped.length > 0) {
        const spanDays = (deduped[deduped.length - 1].time - deduped[0].time) / 86400
        setHistoryInfo(
          `${deduped.length.toLocaleString()} × ${timeframe} candles · ${formatUtc(
            deduped[0].time
          )} → ${formatUtc(deduped[deduped.length - 1].time)} (~${spanDays.toFixed(1)} days)`
        )
      } else if (!message) {
        showInline('info', 'No candles returned for that range.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function onImportHistory(): Promise<void> {
    if (historyCandles.length === 0) return
    if (timeframe !== '1m') {
      showInline(
        'error',
        'Only M1 history can be imported — the app builds 5m/15m/1h/4h/1d automatically.'
      )
      return
    }
    const sym = symbol.trim().toUpperCase()
    setBusy(true)
    try {
      const candlesByTimeframe = buildImportTimeframes(historyCandles)
      const saved = await window.api.saveImport({
        content: `MT5 bridge import: ${sym} M1 ${formatUtc(historyCandles[0].time)} → ${formatUtc(
          historyCandles[historyCandles.length - 1].time
        )}`,
        originalFileName: `mt5-${sym}-M1.csv`,
        symbol: sym,
        candlesByTimeframe
      })
      if (!saved.ok) {
        showInline('error', saved.error)
        return
      }
      const activateTf = saved.meta.timeframe
      const series = candlesByTimeframe[activateTf] || historyCandles
      activateImportedDataset(series, { ...saved.meta, timeframe: activateTf })
      onFeedback?.({
        tone: 'info',
        message: `Imported ${sym} from MetaTrader (${saved.meta.candleCount.toLocaleString()} × 1m).`
      })
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const canImport = historyCandles.length > 0 && timeframe === '1m'
  const messageClass =
    message?.tone === 'error'
      ? 'text-red-400'
      : message?.tone === 'success'
        ? 'text-emerald-400/90'
        : 'text-amber-400/90'

  return (
    <>
      <IconButton
        tooltip="MetaTrader 5 bridge"
        disabled={false}
        tone="accent"
        onClick={() => {
          setMessage(null)
          const nowSec = Math.floor(Date.now() / 1000)
          setFromStr(epochToLocalInput(nowSec - 7 * 86400))
          setToStr(epochToLocalInput(nowSec))
          if (!symbol && eaClients[0]?.hello) setSymbol(eaClients[0].hello.symbol)
          setOpen(true)
        }}
        className="!w-auto gap-1.5 px-2.5"
      >
        <Cable className="h-3.5 w-3.5" />
        <span className="text-xs font-medium">MetaTrader</span>
      </IconButton>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
          role="presentation"
          onClick={() => {
            if (!busy) setOpen(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="mt-bridge-title"
            className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/50"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
              <div>
                <h2 id="mt-bridge-title" className="text-sm font-semibold text-sky-400">
                  MetaTrader 5 bridge
                </h2>
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  Live ticks, bars, and history over a local WebSocket · EasyCandleBridge.mq5
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded border border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <section>
                <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                  Local bridge server
                </span>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    Port
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={port}
                      disabled={running || busy}
                      onChange={(e) => setPort(e.target.value)}
                      className={`${inputClass} w-24`}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onToggleServer()}
                    className={`inline-flex h-8 items-center gap-1.5 rounded border px-3 text-xs font-medium disabled:opacity-40 ${
                      running
                        ? 'border-red-800/70 bg-red-950/40 text-red-300 hover:border-red-600 hover:text-red-200'
                        : 'border-emerald-700/60 bg-emerald-950/40 text-emerald-300 hover:border-emerald-500/80 hover:text-emerald-200'
                    }`}
                  >
                    {running ? <Plug className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {running ? 'Stop server' : 'Start server'}
                  </button>
                  <span className="text-[11px] text-zinc-500">
                    {running ? `Listening on ${server?.url}` : 'Not running'}
                  </span>
                </div>
              </section>

              <section>
                <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                  Connected expert advisors
                </span>
                {eaClients.length === 0 ? (
                  <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-500">
                    No EA connected yet.
                    <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                      <li>Start the bridge server above.</li>
                      <li>
                        Copy <span className="text-zinc-300">EasyCandleBridge.mq5</span> into
                        MT5&apos;s <span className="text-zinc-300">MQL5/Experts</span> folder and
                        compile it in the MetaEditor.
                      </li>
                      <li>
                        Attach the EA to a chart — one chart per symbol you want live data from.
                        Keep Host <span className="text-zinc-300">127.0.0.1</span> and port{' '}
                        <span className="text-zinc-300">{MT_BRIDGE_DEFAULT_PORT}</span>.
                      </li>
                    </ol>
                  </div>
                ) : (
                  <ul className="mt-1.5 divide-y divide-zinc-800/80 rounded border border-zinc-800">
                    {eaClients.map((client) => (
                      <li key={client.id} className="flex items-center gap-3 px-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-2 text-xs font-medium text-zinc-100">
                            {client.hello?.symbol}
                            <span className="rounded-sm border border-emerald-800/60 bg-emerald-950/40 px-1 py-px text-[9px] uppercase tracking-wide text-emerald-300">
                              {client.hello?.isDemo ? 'Demo' : 'Live'}
                            </span>
                          </p>
                          <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                            {client.hello?.terminal} {client.hello?.build} · {client.hello?.server}{' '}
                            · account {client.hello?.account} · digits {client.hello?.digits}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void onTogglePause(client.id)}
                          className="inline-flex h-8 shrink-0 items-center gap-1 rounded border border-zinc-700 bg-zinc-900/80 px-2.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
                        >
                          {paused[client.id] ? (
                            <>
                              <Play className="h-3 w-3" /> Resume
                            </>
                          ) : (
                            <>
                              <Pause className="h-3 w-3" /> Pause
                            </>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {(Object.keys(ticks).length > 0 || Object.keys(bars).length > 0) && (
                <section>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                    Live feed
                  </span>
                  <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {Object.values(ticks).map((tick) => (
                      <div
                        key={tick.symbol}
                        className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                      >
                        <p className="flex items-center justify-between gap-2 text-xs font-medium text-zinc-100">
                          <span className="flex items-center gap-1.5">
                            <Activity className="h-3 w-3 text-emerald-400" />
                            {tick.symbol}
                          </span>
                          <span className="text-[10px] text-zinc-600">{formatUtc(tick.time)}</span>
                        </p>
                        <p className="mt-1 text-[11px] tabular-nums text-zinc-400">
                          Bid <span className="text-zinc-200">{tick.bid}</span> · Ask{' '}
                          <span className="text-zinc-200">{tick.ask}</span> · Last{' '}
                          <span className="text-zinc-200">{tick.last}</span>
                        </p>
                      </div>
                    ))}
                    {Object.values(bars).map((entry) => (
                      <div
                        key={`${entry.symbol}|${entry.timeframe}`}
                        className="rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2"
                      >
                        <p className="flex items-center justify-between gap-2 text-xs font-medium text-zinc-100">
                          <span>
                            {entry.symbol} · {entry.timeframe}
                          </span>
                          <span className="text-[10px] text-zinc-600">
                            {entry.closed ? 'closed' : 'forming'} · {formatUtc(entry.bar.time)}
                          </span>
                        </p>
                        <p className="mt-1 text-[11px] tabular-nums text-zinc-400">
                          O <span className="text-zinc-200">{entry.bar.open}</span> · H{' '}
                          <span className="text-zinc-200">{entry.bar.high}</span> · L{' '}
                          <span className="text-zinc-200">{entry.bar.low}</span> · C{' '}
                          <span className="text-zinc-200">{entry.bar.close}</span>
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                  History
                </span>
                <div className="mt-1.5 flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                    Symbol
                    <input
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value)}
                      placeholder="EURUSD"
                      disabled={busy}
                      className={`${inputClass} w-28 uppercase`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                    Timeframe
                    <select
                      value={timeframe}
                      onChange={(e) => setTimeframe(e.target.value)}
                      disabled={busy}
                      className={inputClass}
                    >
                      {MT_TIMEFRAME_IDS.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                    From (UTC)
                    <input
                      type="datetime-local"
                      value={fromStr}
                      onChange={(e) => setFromStr(e.target.value)}
                      disabled={busy}
                      className={`${inputClass} w-40`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                    To (UTC)
                    <input
                      type="datetime-local"
                      value={toStr}
                      onChange={(e) => setToStr(e.target.value)}
                      disabled={busy}
                      className={`${inputClass} w-40`}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || eaClients.length === 0}
                    onClick={() => void onFetchHistory()}
                    className="inline-flex h-8 items-center gap-1.5 rounded border border-sky-700/60 bg-sky-950/40 px-3 text-xs font-medium text-sky-300 hover:border-sky-500/80 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Fetch
                  </button>
                </div>
                {historyInfo && <p className="mt-1.5 text-[11px] text-zinc-400">{historyInfo}</p>}
                {canImport && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onImportHistory()}
                    className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded border border-amber-500/40 bg-amber-950/40 px-3 text-xs font-medium text-amber-300 hover:border-amber-400/70 hover:text-amber-200 disabled:opacity-40"
                  >
                    <Cable className="h-4 w-4" aria-hidden />
                    Import M1 history into replay
                  </button>
                )}
              </section>

              {activity.length > 0 && (
                <section>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                    Activity
                  </span>
                  <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-500">
                    {[...activity].reverse().map((entry, index) => (
                      <li key={`${entry}-${index}`} className="truncate">
                        {entry}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {server && server.logs.length > 0 && (
                <section>
                  <span className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                    Server log
                  </span>
                  <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-500">
                    {[...server.logs].reverse().map((entry) => (
                      <li key={entry.id} className="truncate">
                        {new Date(entry.time).toLocaleTimeString()} · {entry.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {message && (
                <p className={`text-[11px] leading-relaxed ${messageClass}`}>{message.message}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="inline-flex h-8 items-center rounded border border-zinc-700 bg-zinc-900/80 px-3 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
