// The words and the small drawings of the meter: pure, so each is testable alone.

import type { Cat } from '../types'

const BLOCKS = '▁▂▃▄▅▆▇█'

// A row of blocks, one per value, each as tall as its share of `max` (a percentage by default).
export function spark(values: number[], max = 100): string {
  return values
    .map(v => {
      if (!Number.isFinite(v) || v <= 0) return BLOCKS[0]!
      return BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, Math.ceil((v / max) * BLOCKS.length) - 1))]!
    })
    .join('')
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0.005) return '<$0.01'
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`
}

export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  return n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`
}

// `size` segments, `pct` of them full; any share above zero shows at least one.
export function gauge(pct: number, size = 8): { full: number; empty: number } {
  const p = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  const full = p > 0 ? Math.max(1, Math.round((p / 100) * size)) : 0
  return { full, empty: size - full }
}

// The colour a context share takes: calm, then a warning, then past the line the person set.
export function tone(pct: number, warnAt: number): 'error' | 'warning' | undefined {
  if (pct >= Math.min(99, warnAt + 10)) return 'error'
  if (pct >= warnAt) return 'warning'
  return undefined
}

// A toast once per climb: it fires when the share passes `warnAt` and arms again 10 points below.
export function crossing(warned: boolean, pct: number | undefined, warnAt: number): { warn: boolean; warned: boolean } {
  if (pct === undefined || !Number.isFinite(pct)) return { warn: false, warned }
  if (!warned && pct >= warnAt) return { warn: true, warned: true }
  if (warned && pct < warnAt - 10) return { warn: false, warned: false }
  return { warn: false, warned }
}

// How much each category grew since the snapshot taken after the previous turn.
export function growth(prev: Record<string, number>, cats: Cat[]): Record<string, number> {
  const out: Record<string, number> = {}
  const first = Object.keys(prev).length === 0
  for (const c of cats) out[c.name] = first ? 0 : c.tokens - (prev[c.name] ?? 0)
  return out
}

// The window shrinks only when the conversation is compacted (or cleared). A drop of this much in the
// tokens the used categories hold between two turns is far more than a turn ever frees.
const COMPACT_MIN = 5000
const COMPACT_SHARE = 0.2

export function compacted(prev: Record<string, number>, cats: Cat[]): boolean {
  if (Object.keys(prev).length === 0) return false
  let was = 0
  let now = 0
  for (const c of cats) {
    if (c.kind !== 'used') continue
    was += prev[c.name] ?? 0
    now += c.tokens
  }
  const drop = was - now
  return drop >= COMPACT_MIN && drop >= was * COMPACT_SHARE
}

export const snapshot = (cats: Cat[]): Record<string, number> => Object.fromEntries(cats.map(c => [c.name, c.tokens]))

// "2h 10m", "35m", "now": how long until a window resets.
export function resetsIn(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const mins = Math.round((at - now) / 60_000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h}h ${mins % 60}m`
  return `${Math.round(h / 24)}d`
}

export const windowName = (kind: string): string => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind.replace(/_/g, ' '))

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

// A name or a path that came from the engine or a file: one printable line, cut short.
export function label(s: string, n = 28): string {
  const t = s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(t)
  return chars.length <= n ? t : `${chars.slice(0, n - 1).join('')}…`
}

export const base = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path
