import type { ImportedDatasetMeta } from './importTypes'

/** Where a replay's candles come from: a live feed or a stored import. */
export type ReplayCoverageKind = 'live' | 'imported'

/**
 * Selectable replay range for the active feed. Imported datasets are paged in
 * windows, so coverage is derived from dataset metadata instead of the loaded
 * candle array.
 */
export type ReplayCoverage = {
  kind: ReplayCoverageKind
  /** Earliest selectable start (UTC seconds); 0 when history is unbounded. */
  firstTime: number
  /**
   * Newest covered point (UTC seconds). For `imported` this is the last stored
   * candle open and is itself a valid start; for `live` it is "now", which is
   * not — a start must stay strictly in the past.
   */
  lastTime: number
  /** Candles available for the timeframe; 0 when unknown (live feeds). */
  count: number
}

function toInt(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? n : 0
}

/**
 * Coverage of a stored import for one timeframe. Falls back to the dataset
 * level (1m) bounds when the timeframe has no stats, since every derived series
 * spans the same file.
 */
export function importedCoverage(
  meta: ImportedDatasetMeta | null | undefined,
  timeframe: string
): ReplayCoverage {
  if (!meta) return { kind: 'imported', firstTime: 0, lastTime: 0, count: 0 }

  const stats = meta.timeframes?.[timeframe]
  return {
    kind: 'imported',
    firstTime: Math.max(0, toInt(stats?.firstTime ?? meta.firstTime)),
    lastTime: Math.max(0, toInt(stats?.lastTime ?? meta.lastTime)),
    count: Math.max(0, toInt(stats?.candleCount ?? meta.candleCount))
  }
}

/** Coverage of a live feed: history is unbounded backwards, capped at now. */
export function liveCoverage(nowSeconds: number): ReplayCoverage {
  return { kind: 'live', firstTime: 0, lastTime: Math.max(0, toInt(nowSeconds)), count: 0 }
}

/**
 * Validate a replay start (or jump) time against coverage.
 * Returns an error message, or null when the time is usable.
 *
 * `subject` names the time in live-feed messages ('Start time', 'Jump time').
 * Zero bounds mean "unknown", so they are not enforced.
 */
export function validateReplayStart(
  timeSeconds: number,
  coverage: ReplayCoverage,
  opts: { subject?: string } = {}
): string | null {
  const subject = opts.subject ?? 'Start time'
  const time = Math.floor(Number(timeSeconds))

  if (!Number.isFinite(time)) return `Invalid ${subject.toLowerCase()}.`

  if (coverage.firstTime > 0 && time < coverage.firstTime) {
    return coverage.kind === 'imported'
      ? 'Selected time is before the start of the imported data.'
      : `${subject} is before the available history.`
  }

  if (coverage.lastTime > 0) {
    const tooNew = coverage.kind === 'live' ? time >= coverage.lastTime : time > coverage.lastTime
    if (tooNew) {
      return coverage.kind === 'imported'
        ? 'Selected time is after the end of the imported data.'
        : `${subject} must be in the past (UTC).`
    }
  }

  return null
}
