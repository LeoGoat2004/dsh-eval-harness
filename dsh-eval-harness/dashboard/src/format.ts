/** Shared formatting helpers for the dashboard views. */

/** Format a duration in milliseconds for compact display. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return String(Math.round(ms)) + 'ms'
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return String(minutes) + 'm ' + String(seconds) + 's'
}

/** Format an epoch-millisecond or ISO time as `YYYY-MM-DD HH:mm:ssZ`. */
export function formatTime(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toISOString().replace('T', ' ').slice(0, 19) + 'Z'
}

/** Reduce a token count to a compact human string. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M'
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'k'
  return String(value)
}

/** Format a 0..1 ratio as a percentage. */
export function formatPercent(ratio: number): string {
  return (ratio * 100).toFixed(ratio === 1 || ratio === 0 ? 0 : 1) + '%'
}
