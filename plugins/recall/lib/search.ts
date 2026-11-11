// What turns a search text into a ripgrep pattern and ripgrep's lines into sessions: pure, so each
// piece is testable alone.

// Control characters, and the ones that reorder or hide text: history text must not redraw the pane.
export const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

// What looks like a credential, hidden before anything is shown: history holds tool output.
const SECRET = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:authorization|token|api[-_]?key|secret|passw(?:or)?d|pwd)\b["']?\s*[:=]\s*["']?[^\s"']+/gi,
  /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA)[-_A-Za-z0-9]{8,}/g,
  /\/\/[^/\s:@]+:[^/\s@]+@/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
]
export const redact = (s: string): string => SECRET.reduce((t, re) => t.replace(re, '…'), s)

export const MIN_QUERY = 3
export const MAX_QUERY = 120

// A transcript line is JSON, so the text sits in it with its quotes and backslashes escaped.
export const needleOf = (q: string): string => JSON.stringify(q).slice(1, -1)

export const escapeRe = (s: string): string => s.replace(/[\\.+*?()|[\]{}^$#&~-]/g, '\\$&')

// The match with up to 70 characters each side, so a hit reads as a phrase.
export const patternOf = (q: string): string => `.{0,70}${escapeRe(needleOf(q))}.{0,70}`

// How Claude Code names a project folder: every character that is not a letter or digit becomes `-`.
export const encodeCwd = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

const cut = (s: string, n: number) => {
  const chars = Array.from(s)
  return chars.length <= n ? s : `${chars.slice(0, n - 1).join('')}…`
}

// One hit as the person reads it: the JSON escapes undone, one printable line, credentials hidden.
export function tidy(raw: string, n = 150): string {
  const t = raw
    .replace(/\\(u[0-9a-fA-F]{4}|[nrt"\\/])/g, (_m, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === 'n' || c === 'r' || c === 't' ? ' ' : c))
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cut(redact(t), n)
}

// The folder name without the home prefix, tail kept: that is the part that tells projects apart.
export function shortProject(dir: string): string {
  const s = dir.replace(/^-+/, '').replace(/^(?:Users|home)-[^-]+-/, '')
  const chars = Array.from(s)
  return chars.length <= 34 ? s : `…${chars.slice(-33).join('')}`
}

export type Hit = { project: string; session: string; file: string; text: string }

// `path:text` lines. A transcript is `<project>/<session>.jsonl`; a subagent's sits one level
// deeper, `<project>/<session>/subagents/<agent>.jsonl`, and belongs to that session. A path
// outside the root is dropped.
export function parseHits(stdout: string, root: string): Hit[] {
  const out: Hit[] = []
  const prefix = `${root.replace(/\/+$/, '')}/`
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('.jsonl:')
    if (at < 0) continue
    const file = line.slice(0, at + 6)
    if (!file.startsWith(prefix)) continue
    const parts = file.slice(prefix.length).split('/')
    if (parts.length < 2 || parts.includes('..')) continue
    const session = parts.length === 2 ? parts[1]!.replace(/\.jsonl$/, '') : parts[1]!
    out.push({ project: parts[0]!, session, file, text: line.slice(at + 7) })
  }
  return out
}

export type Found = { id: string; project: string; file: string; texts: string[] }

// A line that opens many sessions the same way (CLAUDE.md, a system reminder, a tool's boilerplate)
// is not what the person is looking for: one found in at least 3 sessions and half of them.
const BOILERPLATE_MIN = 3

// Hits by session, at most `per` distinct lines each, the rarest first. The session being typed in
// is left out (its own search text would match itself), and so is a session whose every line is
// boilerplate; `hidden` counts those.
export function group(hits: Hit[], skipId: string, per = 3): { found: Found[]; hidden: number } {
  const by = new Map<string, Found & { all: string[] }>()
  for (const h of hits) {
    if (h.session === skipId) continue
    let f = by.get(h.session)
    if (!f) {
      f = { id: h.session, project: h.project, file: h.file, texts: [], all: [] }
      by.set(h.session, f)
    }
    const t = tidy(h.text)
    if (t.length > 0 && !f.all.includes(t)) f.all.push(t)
  }
  const sessions = [...by.values()].filter(f => f.all.length > 0)
  const seen = new Map<string, number>()
  for (const f of sessions) for (const t of f.all) seen.set(t, (seen.get(t) ?? 0) + 1)
  const common = (t: string) => (seen.get(t) ?? 0) >= BOILERPLATE_MIN && (seen.get(t) ?? 0) * 2 >= sessions.length
  const found: Found[] = []
  let hidden = 0
  for (const f of sessions) {
    const real = f.all.filter(t => !common(t))
    if (real.length === 0 && sessions.some(o => o.all.some(t => !common(t)))) {
      hidden++
      continue
    }
    found.push({ id: f.id, project: f.project, file: f.file, texts: [...real, ...f.all.filter(common)].slice(0, per) })
  }
  return { found, hidden }
}

const two = (n: number) => String(n).padStart(2, '0')

export function when(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}
