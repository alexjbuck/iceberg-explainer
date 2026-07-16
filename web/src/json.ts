/** JSON.stringify replacer — BigInt values become strings for display. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

export function toJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, jsonReplacer, indent)
}

export function daysToIso(days: number): string {
  const ms = days * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

export function isoToDays(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000)
}

export function formatRow(row: Record<string, unknown>): Record<string, string> {
  const date = row.date
  let dateStr: string
  if (typeof date === 'number') dateStr = daysToIso(date)
  else if (date instanceof Date) dateStr = date.toISOString().slice(0, 10)
  else dateStr = String(date ?? '')
  return {
    date: dateStr,
    state: String(row.state ?? ''),
    value: String(row.value ?? ''),
  }
}
