/**
 * The original renderer's display helpers, reproduced so the interface reads
 * exactly as before: `prettier-bytes` sizing and its ETA phrasing.
 */
export function prettyBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1000)),
    units.length - 1
  )
  const scaled = value / 1000 ** exponent
  const rounded = scaled >= 10 || exponent === 0 ? Math.round(scaled) : scaled
  return `${exponent === 0 ? rounded : Number(rounded.toFixed(1))} ${units[exponent]}`
}

/** The original player clock: `m:ss`, growing to `h:mm:ss` for long media. */
export function formatTime(time: number, total: number): string {
  if (!Number.isFinite(time)) return '0:00'

  const totalHours = Math.floor(total / 3600)
  const totalMinutes = Math.floor(total / 60)
  const hours = Math.floor(time / 3600)
  const rawMinutes = Math.floor((time % 3600) / 60)
  const minutes =
    totalMinutes > 9 && rawMinutes < 10 ? `0${rawMinutes}` : `${rawMinutes}`
  const seconds = `0${Math.floor(time % 60)}`.slice(-2)

  return `${totalHours > 0 ? `${hours}:` : ''}${minutes}:${seconds}`
}

export function calculateEta(
  missingBytes: number,
  downloadSpeed: number
): string {
  if (downloadSpeed <= 0 || missingBytes <= 0) return ''
  const seconds = Math.round(missingBytes / downloadSpeed)
  if (seconds < 10) return 'ETA: a few seconds remaining'

  const units: ReadonlyArray<[string, number]> = [
    ['minute', 60],
    ['hour', 60],
    ['day', 24]
  ]
  let unit = 'second'
  let amount = seconds
  for (const [name, divisor] of units) {
    if (amount < divisor) break
    amount = Math.round(amount / divisor)
    unit = name
  }
  return `ETA: ${amount} ${unit}${amount === 1 ? '' : 's'} remaining`
}
