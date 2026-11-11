// The words of a card: what an agent is doing, what it answered, what role it plays.

import type { Card } from '../types'
import { COSTUME_ACCENT } from './dance'
import { costumeFor } from './sprites'

// Control characters, and the ones that reorder or hide text (bidi marks and overrides, zero
// width, line and paragraph separators): text an agent chose must not be able to redraw a card.
export const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

const clean = (s: string) => s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()
// By code points, so a character outside the basic plane is never cut in half.
const cut = (s: string, n: number) => {
  const chars = Array.from(s)
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join('')}…`
}
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// What looks like a credential, hidden before anything goes on the card.
const SECRET = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:authorization|token|api[-_]?key|secret|passw(?:or)?d|pwd)\b["']?\s*[:=]\s*["']?[^\s"']+/gi,
  /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{8,}/g,
  /\/\/[^/\s:@]+:[^/\s@]+@/g,
]
export const redact = (s: string): string => SECRET.reduce((t, re) => t.replace(re, '…'), s)

type Call = { tool?: unknown; [k: string]: unknown }

const str = (v: unknown) => (typeof v === 'string' ? v : '')

// What one tool call comes to on a card: the tool and where it points, short. A shell command
// or a search text is cut early, since it can carry things the person would not want on show.
export function describeCall(e: Call): string {
  const tool = String(e.tool ?? '')
  const path = str(e.file_path) || str(e.notebook_path) || str(e.path)
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool) && path) return `${tool} ${cut(clean(base(path)), 40)}`
  if (tool === 'Bash') return `Bash ${cut(clean(redact(str(e.command))), 36)}`.trim()
  if (tool === 'Grep' || tool === 'Glob') return `${tool} ${cut(clean(redact(str(e.pattern))), 36)}`.trim()
  if (tool === 'WebFetch') return `WebFetch ${cut(clean(str(e.url)).replace(/^[a-z]+:\/\//i, '').replace(/^[^/]*@/, '').replace(/[?#].*$/, ''), 36)}`.trim()
  if (tool === 'WebSearch') return `WebSearch ${cut(clean(redact(str(e.query))), 36)}`.trim()
  if (tool === 'Agent' || tool === 'Task') return `Agent ${cut(clean(str(e.description)), 36)}`.trim()
  return cut(clean(tool), 40)
}

// The first line worth showing of an agent's final answer, markdown marks off.
export function resultLine(answer: unknown): string {
  if (typeof answer !== 'string') return ''
  for (const raw of answer.split('\n')) {
    const line = clean(
      raw
        .replace(/^[\s>#*\-+`|]+/, '')
        .replace(/[*`]+/g, '')
        // emphasis in underscores only: an underscore inside an identifier stays
        .replace(/(^|\s)_+([^_\s][^_]*?)_+(?=\s|$|[.,;:!?])/g, '$1$2'),
    )
    if (line.length > 1) return cut(redact(line), 90)
  }
  return ''
}

const ROLES: [RegExp, string][] = [
  [/explore|investigat|search/, 'EXPLORE'],
  [/opus|architect/, 'ARCHITECT'],
  [/plan/, 'PLAN'],
  [/build|implement|routine/, 'BUILD'],
  [/review|audit|critic/, 'REVIEW'],
  [/general/, 'GENERAL'],
]

// The word on a card's chip. A type the table does not know shows its own name, trimmed.
export function roleLabel(type: string): string {
  const t = type.toLowerCase()
  for (const [re, label] of ROLES) if (re.test(t)) return label
  const last = clean(type.split(':').pop() ?? type)
  return cut(last.toUpperCase(), 10) || 'AGENT'
}

// The chip's colour is the outfit's accent.
export const roleColor = (type: string): string => COSTUME_ACCENT[costumeFor(type)] ?? '#888780'

export const shortModel = (model: string): string => model.replace(/^claude-/, '').replace(/\[.*\]$/, '')

// A bar of `size` segments, `pct` of them full.
export function meter(pct: number, size = 8): { full: number; empty: number } {
  if (!Number.isFinite(pct)) pct = 0
  const full = Math.max(0, Math.min(size, Math.round((pct / 100) * size)))
  return { full: pct > 0 && full === 0 ? 1 : full, empty: size - (pct > 0 && full === 0 ? 1 : full) }
}

// --- Cost -------------------------------------------------------------------------------------
// The plugin ships no prices: they change, and a wrong one is worse than none. The person gives a
// table (USD per million tokens, by model name) and a card shows a cost only for a model in it.

export type Price = { in: number; out: number; cacheR?: number; cacheW?: number }
export type PriceTable = Record<string, Price>

const MAX_PRICE = 1e6
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_PRICE ? x : undefined)
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// `{"sonnet-5-5": {"in": 3, "out": 15, "cacheR": 0.3, "cacheW": 3.75}}`. Anything that is not
// that shape is dropped one entry at a time, so a typo costs the entry and not the table. A
// cache price that is there but wrong drops its entry too: falling back to the input price
// would show a cost that looks right and is not. A name needs 3 characters with a letter or
// a digit, or it would match every model.
export function parsePrices(text: string): PriceTable {
  const body = text.replace(/^\ufeff/, '').trim()
  if (!body) return {}
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: PriceTable = {}
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const model = name.trim().toLowerCase()
    if (UNSAFE_KEYS.has(model) || model.length < 3 || !/[a-z0-9]/.test(model)) continue
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const p = v as Record<string, unknown>
    const input = num(p.in)
    const output = num(p.out)
    if (input === undefined || output === undefined) continue
    const cacheR = num(p.cacheR)
    const cacheW = num(p.cacheW)
    if ((p.cacheR !== undefined && cacheR === undefined) || (p.cacheW !== undefined && cacheW === undefined)) continue
    out[model] = { in: input, out: output, ...(cacheR === undefined ? {} : { cacheR }), ...(cacheW === undefined ? {} : { cacheW }) }
  }
  return out
}

// The entry whose key is the longest part of the model id, so "opus-5-5" wins over "opus".
export function priceFor(table: PriceTable, model: string): Price | undefined {
  const id = model.toLowerCase()
  let best: string | undefined
  for (const key of Object.keys(table)) if (id.includes(key) && (best === undefined || key.length > best.length)) best = key
  return best === undefined ? undefined : table[best]
}

type Tokens = Pick<Card, 'inTok' | 'cacheR' | 'cacheW' | 'out'>
const n0 = (x: number) => (Number.isFinite(x) ? x : 0)

export const hasTokens = (c: Tokens) => n0(c.inTok) + n0(c.cacheR) + n0(c.cacheW) + n0(c.out) > 0

// A cache price left out: a read falls back to the input price, which overstates (a read costs a
// tenth of it), and a write to 1.25 times the input price, the 5 minute rate, which is what it
// costs for every model on the pricing page. A token count that is not a number counts as none,
// so one odd usage never turns a card or the total into NaN.
export const CACHE_WRITE_RATE = 1.25
export function costOf(c: Tokens, p: Price): number {
  const cost = (n0(c.inTok) * p.in + n0(c.out) * p.out + n0(c.cacheR) * (p.cacheR ?? p.in) + n0(c.cacheW) * (p.cacheW ?? p.in * CACHE_WRITE_RATE)) / 1e6
  return Number.isFinite(cost) ? cost : 0
}

export function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n < 0.005) return '<$0.01'
  return n < 10 ? `~$${n.toFixed(2)}` : `~$${Math.round(n)}`
}

type Usage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown }
const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)

// What one model request cost, at the price of the model that ran it. `tokens`: the step had
// some; `priced`: it also had a price, so `cost` means something.
export function stepCost(u: Usage | null | undefined, p: Price | undefined): { cost: number; tokens: boolean; priced: boolean } {
  const t = { inTok: count(u?.input_tokens), out: count(u?.output_tokens), cacheR: count(u?.cache_read_input_tokens), cacheW: count(u?.cache_creation_input_tokens) }
  const tokens = hasTokens(t)
  return p && tokens ? { cost: costOf(t, p), tokens, priced: true } : { cost: 0, tokens, priced: false }
}
