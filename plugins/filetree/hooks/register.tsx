import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Entry, GitInfo, PrFacts, PrInfo, Preview, Touch } from '../types'

const PANE = 'filetree'
// Never listed.
const HIDDEN = new Set(['.git', '.DS_Store'])
// Listed, but a touched file inside never opens them on its own.
const NO_REVEAL = new Set(['.git', 'node_modules', '.DS_Store'])
const MAX_CHILDREN = 300
const MAX_HITS = 100
const MAX_OPEN = 100
const MAX_TOUCHED = 300
const DEBOUNCE_MS = 500

// Bump a tag when the shape of its value changes: a reload declines what an
// older version stored.
const root = atom({ plugin: 'filetree', key: 'root' } as const, '', { shape: 'root-1' })
const open = atom({ plugin: 'filetree', key: 'open' } as const, {} as Record<string, boolean>, { shape: 'open-1' })
const children = atom({ plugin: 'filetree', key: 'children' } as const, {} as Record<string, Entry[]>, { shape: 'children-1' })
const touched = atom({ plugin: 'filetree', key: 'touched' } as const, {} as Record<string, Touch>, { shape: 'touched-1' })
const git = atom({ plugin: 'filetree', key: 'git' } as const, null as GitInfo | null, { shape: 'git-3' })
// Branches where Claude wrote a file while it was a protected one.
const guard = atom({ plugin: 'filetree', key: 'guard' } as const, {} as Record<string, boolean>, { shape: 'guard-1' })
// The file the person clicked, as a snapshot: a diff when git sees a change,
// else the start of its content.
const peek = atom({ plugin: 'filetree', key: 'peek' } as const, null as Preview | null, { shape: 'peek-1' })
const pull = atom({ plugin: 'filetree', key: 'pull' } as const, null as PrInfo | null, { shape: 'pull-1' })
// The search box's text, and the files it found (null: nothing searched yet).
const query = atom({ plugin: 'filetree', key: 'query' } as const, '', { shape: 'query-1' })
// First line of the preview on screen: the preview is paged, not scrolled.
const peekTop = atom({ plugin: 'filetree', key: 'peekTop' } as const, 0, { shape: 'peektop-1' })
const hits = atom({ plugin: 'filetree', key: 'hits' } as const, null as string[] | null, { shape: 'hits-1' })

// From the manifest's userConfig. The GitHub lookup is off until the user turns
// it on: it runs `gh` and reaches the network.
const cfg = { github: false, ttl: 300, icons: 'nerd' as 'dot' | 'nerd' | 'none', autoOpen: true }

// Glyph per file type: `nerd` needs a Nerd Font, `dot` works in any font.
const BY_NAME: Record<string, [string, string]> = {
  '.gitignore': ['', '#f14e32'],
  'CLAUDE.md': ['', '#d97757'],
  Dockerfile: ['', '#458ee6'],
  'package.json': ['', '#8bc34a'],
}
const BY_EXT: Record<string, [string, string]> = {
  ts: ['', '#519aba'],
  tsx: ['', '#519aba'],
  js: ['', '#cbcb41'],
  jsx: ['', '#519aba'],
  mjs: ['', '#cbcb41'],
  json: ['', '#cbcb41'],
  md: ['', '#519aba'],
  html: ['', '#e44d26'],
  css: ['', '#a074c4'],
  py: ['', '#ffbc03'],
  sh: ['', '#89e051'],
  yml: ['', '#cc6666'],
  yaml: ['', '#cc6666'],
  toml: ['', '#9c4221'],
  lock: ['', '#8a8a8a'],
  log: ['', '#8a8a8a'],
  png: ['', '#a074c4'],
  jpg: ['', '#a074c4'],
  jpeg: ['', '#a074c4'],
  gif: ['', '#a074c4'],
  svg: ['', '#ffb13b'],
}
const PLAIN: [string, string] = ['', '#8a8a8a']

// The glyph and the colour a file name takes. `.env` and its kin read as config.
export function fileIcon(name: string): { nerd: string; color: string } {
  const hit = BY_NAME[name] ?? (/^\.env(\..+)?$/.test(name) ? (['', '#faf743'] as [string, string]) : undefined)
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const [nerd, color] = hit ?? BY_EXT[ext] ?? PLAIN
  return { nerd, color }
}

const TOUCH: Record<string, 'read' | 'write' | 'bash'> = {
  Read: 'read',
  Edit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
  Bash: 'bash',
}

// Names that usually hold a secret. A visual alert only: it never blocks a
// call, which is the job of a permission rule or a PreToolUse hook.
const SENSITIVE = [
  /^\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/,
  /^(credentials|secrets?)(\..+)?$/,
  /^\.(npmrc|netrc|pgpass)$/,
  /service[-_]?account.*\.json$/,
]
// Branches the work should not land on directly: a feature branch comes first.
const PROTECTED = new Set(['main', 'master'])
const SAFE_COPY = /\.(example|sample|template|dist)$/

export function isSensitive(path: string): boolean {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  return !SAFE_COPY.test(name) && SENSITIVE.some(re => re.test(name))
}

// Without --no-optional-locks a status run can take index.lock while Claude
// commits; core.fsmonitor=false keeps a cloned repo's config from running code.
const GIT = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false']

// Folders the plugin opened for a touched file; past the cap a collapsed
// folder only carries its marker, so a burst of reads cannot swell the tree.
const MAX_AUTO = 20
const autoOpened = new Set<string>()

let busy = false
let pending: { cancel: () => void } | undefined

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')

async function real($: EngineInterface, path: string): Promise<string> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return stat?.realPath ?? path
}

async function listDir($: EngineInterface, dir: string): Promise<Entry[]> {
  const raw = await $.fs.list(dir).catch(() => [])
  const all: Entry[] = raw
    .filter(e => !HIDDEN.has(e.name))
    .map(e => ({ name: e.name, kind: e.isLink ? 'other' : e.kind }))
    .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
  if (all.length <= MAX_CHILDREN) return all
  return [...all.slice(0, MAX_CHILDREN), { name: `… ${all.length - MAX_CHILDREN} more`, kind: 'more' }]
}

export type Parsed = {
  branch: string
  oid: string
  upstream: boolean
  ahead: number
  behind: number
  entries: [string, string][]
  ignored: string[]
}

// `git status --porcelain=v2 -b -z`: header lines start with "# ", changed
// entries with 1, 2 (rename or copy, followed by its original path) or u
// (unmerged), untracked ones with "?". XY uses "." for unchanged; it is
// stored with a space instead.
export function parseStatus(out: string): Parsed {
  const parts = out.split('\0')
  const res: Parsed = { branch: '', oid: '', upstream: false, ahead: 0, behind: 0, entries: [], ignored: [] }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? ''
    if (part.startsWith('# ')) {
      const [key, ...rest] = part.slice(2).split(' ')
      const val = rest.join(' ')
      if (key === 'branch.head') res.branch = val
      else if (key === 'branch.oid') res.oid = val
      else if (key === 'branch.upstream') res.upstream = true
      else if (key === 'branch.ab') {
        res.ahead = Number(/\+(\d+)/.exec(val)?.[1] ?? 0)
        res.behind = Number(/-(\d+)/.exec(val)?.[1] ?? 0)
      }
      continue
    }
    if (part.startsWith('? ')) {
      res.entries.push([part.slice(2).replace(/\/$/, ''), '??'])
      continue
    }
    if (part.startsWith('! ')) {
      res.ignored.push(part.slice(2).replace(/\/$/, ''))
      continue
    }
    const at = part[0] === '1' ? 8 : part[0] === '2' ? 9 : part[0] === 'u' ? 10 : -1
    if (at < 0) continue
    const f = part.split(' ')
    const path = f.slice(at).join(' ').replace(/\/$/, '')
    if (part[0] === '2') i++
    if (path) res.entries.push([path, (f[1] ?? '..').replace(/\./g, ' ')])
  }
  return res
}

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

// What one status code looks like: staged, changed in the working tree,
// untracked, or in conflict.
export function badges(xy: string): [glyph: string, color: string][] {
  if (xy === '??') return [['?', 'success']]
  if (CONFLICT.has(xy)) return [['✖', 'error']]
  const out: [string, string][] = []
  if (xy[0] !== ' ') out.push(['✚', 'success'])
  if (xy[1] === 'D') out.push(['−', 'error'])
  else if (xy[1] !== ' ') out.push(['●', 'warning'])
  return out
}

export function tally(files: Record<string, string>) {
  const n = { staged: 0, changed: 0, untracked: 0, conflicts: 0 }
  for (const xy of Object.values(files)) {
    if (xy === '??') n.untracked++
    else if (CONFLICT.has(xy)) n.conflicts++
    else {
      if (xy[0] !== ' ') n.staged++
      if (xy[1] !== ' ') n.changed++
    }
  }
  return n
}

// Marker files git keeps in its directory while an operation is unfinished.
const OPS: [string, string][] = [
  ['MERGE_HEAD', 'MERGING'],
  ['rebase-merge', 'REBASING'],
  ['rebase-apply', 'REBASING'],
  ['CHERRY_PICK_HEAD', 'CHERRY-PICKING'],
  ['REVERT_HEAD', 'REVERTING'],
  ['BISECT_LOG', 'BISECTING'],
]

async function operation($: EngineInterface, gitDir: string): Promise<string> {
  for (const [file, label] of OPS) {
    if (await $.fs.stat(`${gitDir}/${file}`).then(() => true, () => false)) return label
  }
  return ''
}

// owner/repo of a github.com remote, else undefined. Anything else (another
// host, a URL with credentials, odd characters) is refused rather than guessed.
export function githubRepo(url: string): string | undefined {
  const m =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url) ??
    /^ssh:\/\/git@github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url)
  return m ? `${m[1]}/${m[2]}` : undefined
}

const CHECK_BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const CHECK_WAIT = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

// `gh pr list --json ...` -> what the pane shows. A check run carries `status`
// and `conclusion`, a commit status carries `state`; the answer is read
// defensively, since it is data from outside.
export function summarizePr(raw: unknown): PrFacts | undefined {
  const pr = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined) : undefined
  if (!pr || typeof pr.number !== 'number') return undefined
  const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft === true ? 'draft' : 'open'
  const roll = Array.isArray(pr.statusCheckRollup) ? (pr.statusCheckRollup as Record<string, unknown>[]) : []
  let bad = false
  let wait = false
  for (const c of roll) {
    const done = String(c?.conclusion ?? c?.state ?? '').toUpperCase()
    const status = String(c?.status ?? '').toUpperCase()
    if (CHECK_BAD.has(done)) bad = true
    else if ((status !== '' && status !== 'COMPLETED') || CHECK_WAIT.has(done)) wait = true
  }
  const review = pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : pr.reviewDecision === 'REVIEW_REQUIRED' ? 'required' : 'none'
  return { number: pr.number, state, checks: roll.length === 0 ? 'none' : bad ? 'fail' : wait ? 'pending' : 'pass', review }
}

// gh reads its own login, never a prompt; git inside it keeps a repo's
// fsmonitor from running.
const GH_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  NO_COLOR: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
}

let prBusy = false
let prForce = false

// The current branch's pull request. Rare on purpose: cached per repo and
// branch, a short wait while nothing is settled (no PR, checks running, an
// error), the configured one otherwise, and a press of "refresh" forces it.
async function lookupPr($: EngineInterface, dir: string, at: { branch: string; upstream: boolean; detached: boolean; initial: boolean }): Promise<void> {
  if (!cfg.github || prBusy) return
  prBusy = true
  try {
    if (at.detached || at.initial) {
      await update($, pull, () => null)
      return
    }
    const init = { env: GH_ENV, timeoutMs: 5_000 }
    const url = await $.process.run([...GIT, '-C', dir, 'remote', 'get-url', 'origin'], init).catch(() => undefined)
    const repo = url?.exitCode === 0 ? githubRepo(url.stdout.trim()) : undefined
    if (!repo) {
      await update($, pull, () => null)
      return
    }
    const key = `${repo}#${at.branch}#${at.upstream ? 'u' : 'n'}`
    const cur = await read($, pull)
    const force = prForce
    prForce = false
    const wait = (cur?.status !== 'ok' || cur.checks === 'pending' ? Math.min(cfg.ttl, 60) : cfg.ttl) * 1000
    if (!force && cur?.key === key && Date.now() - cur.at < wait) return
    const base = { key, branch: at.branch, at: Date.now() }
    if (!at.upstream) {
      await update($, pull, () => ({ ...base, status: 'none' }))
      return
    }
    const fields = 'number,state,isDraft,reviewDecision,statusCheckRollup'
    const res = await $.process
      .run(['gh', 'pr', 'list', '--repo', repo, `--head=${at.branch}`, '--state', 'all', '--limit', '1', '--json', fields], { env: GH_ENV, timeoutMs: 10_000 })
      .catch(() => undefined)
    if (!res || res.exitCode !== 0 || res.isStdoutTruncated) {
      await update($, pull, () => ({ ...base, status: 'error' }))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.stdout)
    } catch {
      await update($, pull, () => ({ ...base, status: 'error' }))
      return
    }
    const facts = summarizePr(parsed)
    await update($, pull, () => (facts ? { ...base, status: 'ok', ...facts } : { ...base, status: Array.isArray(parsed) && parsed.length === 0 ? 'none' : 'error' }))
  } catch {
    // never reaches a refresh
  } finally {
    prBusy = false
  }
}

async function refreshGit($: EngineInterface): Promise<void> {
  const dir = await read($, root)
  if (!dir) return
  const init = { env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 5_000 }
  const run = (args: string[]) => $.process.run([...GIT, '-C', dir, ...args], init).catch(() => undefined)
  const top = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir'])
  const [toplevel, gitDir] = top?.exitCode === 0 ? top.stdout.trim().split('\n') : []
  if (!toplevel || !gitDir) {
    await update($, git, () => null)
    return
  }
  const base = await real($, toplevel)
  const [status, stash, op] = await Promise.all([
    run(['status', '--porcelain=v2', '-b', '-z', '--untracked-files=normal', '--ignored=matching']),
    run(['stash', 'list']),
    operation($, gitDir),
  ])
  if (!status || status.exitCode !== 0) return
  const parsed = parseStatus(status.stdout)
  const files: Record<string, string> = {}
  for (const [rel, xy] of parsed.entries) files[`${base}/${rel}`] = xy
  const ignored: Record<string, boolean> = {}
  for (const rel of parsed.ignored) ignored[`${base}/${rel}`] = true
  const initial = parsed.oid === '(initial)'
  void lookupPr($, dir, { branch: parsed.branch, upstream: parsed.upstream, detached: parsed.branch === '(detached)', initial })
  await update($, git, () => ({
    branch: parsed.branch,
    oid: initial ? '' : parsed.oid.slice(0, 7),
    initial,
    detached: parsed.branch === '(detached)',
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    stash: stash?.exitCode === 0 ? stash.stdout.split('\n').filter(Boolean).length : 0,
    op,
    files,
    ignored,
  }))
}

// The tree follows the session's project root, which moves on /cd, a host's
// directory change or a worktree move. A shell `cd` does not move it, so the
// tree does not jump into a subfolder each time Claude runs `cd pkg && test`.
async function syncRoot($: EngineInterface): Promise<void> {
  const raw = await $.session.root().catch(() => undefined)
  if (!raw) return
  const dir = await real($, raw)
  if (dir === (await read($, root))) return
  autoOpened.clear()
  await update($, root, () => dir)
  await update($, open, () => ({}))
  await update($, children, () => ({}))
  await update($, git, () => null)
  await update($, query, () => '')
  await update($, hits, () => null)
}

let searching: { cancel: () => void } | undefined

// Files whose path holds the text. Git's own list (tracked plus untracked,
// minus what is ignored) covers folders nobody opened; outside a repository
// only what the tree has already listed can be searched.
async function search($: EngineInterface, text: string): Promise<void> {
  const needle = text.trim().toLowerCase()
  if (!needle) {
    await update($, hits, () => null)
    return
  }
  const dir = await read($, root)
  if (!dir) return
  const res = await $.process
    .run([...GIT, '-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 5_000 })
    .catch(() => undefined)
  let all: string[]
  if (res && res.exitCode === 0) {
    all = res.stdout.split('\0').filter(Boolean)
  } else {
    const listing = await read($, children)
    all = Object.entries(listing).flatMap(([d, list]) => list.filter(e => e.kind === 'file' || e.kind === 'other').map(e => `${d}/${e.name}`.slice(dir.length + 1)))
  }
  const found = [...new Set(all)]
    .filter(rel => rel.toLowerCase().includes(needle))
    .sort((a, b) => Number(!(a.split('/').pop() ?? a).toLowerCase().includes(needle)) - Number(!(b.split('/').pop() ?? b).toLowerCase().includes(needle)) || a.length - b.length || a.localeCompare(b))
    .slice(0, MAX_HITS)
  // a later keystroke already moved on
  if ((await read($, query)).trim().toLowerCase() !== needle) return
  await update($, hits, () => found)
}

async function typed($: EngineInterface, text: string, now = false): Promise<void> {
  await update($, query, () => text)
  searching?.cancel()
  if (!text.trim()) {
    await update($, hits, () => null)
    return
  }
  if (now) await search($, text)
  else searching = await $.clock.after(250, () => void search($, text).catch(() => undefined))
}

async function collapse($: EngineInterface): Promise<void> {
  autoOpened.clear()
  await update($, open, () => ({}))
}

// Opens the folders down to a file Claude touched, so its colour shows.
async function reveal($: EngineInterface, file: string): Promise<void> {
  const base = await read($, root)
  if (!base || !file.startsWith(`${base}/`)) return
  const dirs = ancestors(file, base)
  if (dirs.some(d => NO_REVEAL.has(d.split('/').pop() ?? ''))) return
  const opened = await read($, open)
  const need = dirs.filter(d => opened[d] !== true)
  if (need.length === 0 || autoOpened.size + need.length > MAX_AUTO) return
  const lists = await Promise.all(need.map(async d => [d, await listDir($, d)] as const))
  await update($, children, c => ({ ...c, ...Object.fromEntries(lists) }))
  await update($, open, o => ({ ...o, ...Object.fromEntries(need.map(d => [d, true])) }))
  for (const d of need) autoOpened.add(d)
}

async function refresh($: EngineInterface): Promise<void> {
  if (busy) return
  busy = true
  try {
    await syncRoot($)
    const dir = await read($, root)
    if (!dir) return
    const opened = await read($, open)
    const dirs = [dir, ...Object.keys(opened).filter(k => opened[k] === true)].slice(0, MAX_OPEN)
    const lists = await Promise.all(dirs.map(async d => [d, await listDir($, d)] as const))
    await update($, children, () => Object.fromEntries(lists))
    await refreshGit($)
    // an open preview follows the file, so it never shows a stale diff
    const open_ = await read($, peek)
    if (open_) await loadPeek($, open_.path)
  } catch {
    // the session can end or reload under a refresh in flight
  } finally {
    busy = false
  }
}

async function schedule($: EngineInterface, ms = DEBOUNCE_MS): Promise<void> {
  pending?.cancel()
  pending = await $.clock.after(ms, () => void refresh($))
}

const MAX_PEEK_LINES = 400
const MAX_PEEK_LINE = 160
const MAX_PEEK_BYTES = 1_048_576

// File text is untrusted: tabs become spaces, a CR is dropped, every other
// control character (an escape sequence included) is shown as "?".
const shape = (text: string) =>
  text
    .split('\n')
    .map(l => clean(l.replace(/\r$/, '').replace(/\t/g, '  ')).slice(0, MAX_PEEK_LINE))

export function describe(code: string): string {
  if (!code) return 'unchanged'
  if (code === '??') return 'untracked'
  if (CONFLICT.has(code)) return 'conflict'
  const out: string[] = []
  if (code[0] !== ' ') out.push('staged')
  if (code[1] === 'D') out.push('deleted')
  else if (code[1] !== ' ') out.push('modified')
  return out.join(' + ')
}

// The colour a file name takes from its git state.
export function gitTone(code: string | undefined): string | undefined {
  if (!code) return undefined
  if (CONFLICT.has(code) || code[1] === 'D') return 'error'
  if (code === '??') return 'success'
  return code[1] !== ' ' ? 'warning' : 'success'
}

async function loadPeek($: EngineInterface, path: string): Promise<void> {
  const file = await real($, path)
  const info = await read($, git)
  const dir = await read($, root)
  const code = info?.files[path] ?? info?.files[file] ?? ''
  const base: Preview = { path, name: clean(path.split('/').pop() ?? path), code, kind: 'content', note: '', lines: [], more: 0, added: 0, removed: 0 }
  const show = async (over: Partial<Preview>): Promise<void> => {
    await update($, peek, () => ({ ...base, ...over }))
  }
  try {
    // what a secret file holds never goes on screen from a click
    if (isSensitive(path) || isSensitive(file)) return await show({ kind: 'hidden', note: 'sensitive file: preview hidden' })

    if (code && code !== '??' && dir) {
      // no external diff driver or textconv: a cloned repo's config must not run code
      const diff = await $.process
        .run([...GIT, '-C', dir, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U2', 'HEAD', '--', file], { env: { GIT_OPTIONAL_LOCKS: '0' }, timeoutMs: 5_000 })
        .catch(() => undefined)
      if (diff && diff.exitCode === 0 && diff.stdout.trim() !== '') {
        if (/^Binary files .* differ$/m.test(diff.stdout)) return await show({ kind: 'binary', note: 'binary file changed' })
        const all = diff.stdout.split('\n')
        const body = all.slice(Math.max(0, all.findIndex(l => l.startsWith('@@'))))
        if (body.at(-1) === '') body.pop()
        const added = body.filter(l => l.startsWith('+')).length
        const removed = body.filter(l => l.startsWith('-')).length
        return await show({ kind: 'diff', lines: shape(body.slice(0, MAX_PEEK_LINES).join('\n')), more: Math.max(0, body.length - MAX_PEEK_LINES), added, removed })
      }
    }

    const stat = await $.fs.stat(file).catch(() => undefined)
    if (!stat) return await show({ kind: 'error', note: 'file not found' })
    if (stat.kind !== 'file') return await show({ kind: 'error', note: 'not a regular file' })
    if (stat.size > MAX_PEEK_BYTES) return await show({ kind: 'large', note: `${Math.round(stat.size / 1024)} KB: too large to preview` })
    const text = await $.fs.read(file).catch(() => undefined)
    if (text === undefined) return await show({ kind: 'error', note: 'could not read the file' })
    if (text.slice(0, 8192).includes('\0')) return await show({ kind: 'binary', note: 'binary file' })
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    await show({ lines: shape(lines.slice(0, MAX_PEEK_LINES).join('\n')), more: Math.max(0, lines.length - MAX_PEEK_LINES) })
  } catch {
    await show({ kind: 'error', note: 'preview failed' }).catch(() => undefined)
  }
}

// A second press on the same file closes it.
async function select($: EngineInterface, path: string): Promise<void> {
  const cur = await read($, peek)
  await update($, peekTop, () => 0)
  if (cur?.path === path) await update($, peek, () => null)
  else await loadPeek($, path)
}

async function toggle($: EngineInterface, dir: string): Promise<void> {
  const isOpen = (await read($, open))[dir] === true
  if (!isOpen) {
    const list = await listDir($, dir)
    await update($, children, c => ({ ...c, [dir]: list }))
  }
  await update($, open, o => ({ ...o, [dir]: !isOpen }))
}

// Two warnings on a write, both toasts and neither blocking. Git's state is
// the last refresh's, so it can trail a very recent change by a moment.
async function warnWrite($: EngineInterface, file: string, before: Touch | undefined): Promise<void> {
  const info = await read($, git)
  if (!info) return
  const name = clean(file.split('/').pop() ?? file)
  if (before?.kind !== 'write' && info.files[file] !== undefined) {
    void $.ui.toast(`Claude changed a file with uncommitted changes: ${name}`)
  }
  if (!info.detached && PROTECTED.has(info.branch) && (await read($, guard))[info.branch] !== true) {
    await update($, guard, g => ({ ...g, [info.branch]: true }))
    void $.ui.toast(`Claude changed a file on ${clean(info.branch)}: use a feature branch`)
  }
}

async function touch($: EngineInterface, path: string, kind: 'read' | 'write'): Promise<void> {
  const file = await real($, path)
  const before = (await read($, touched))[file]
  if (before?.kind !== kind && (isSensitive(path) || isSensitive(file))) {
    const name = clean(file.split('/').pop() ?? file)
    void $.ui.toast(`Claude ${kind === 'read' ? 'read' : 'changed'} a sensitive file: ${name}`)
  }
  if (kind === 'write') await warnWrite($, file, before)
  await update($, touched, t => {
    const next = { ...t, [file]: { kind, at: Date.now() } }
    const keys = Object.keys(next)
    if (keys.length <= MAX_TOUCHED) return next
    const keep = keys.sort((a, b) => (next[b]?.at ?? 0) - (next[a]?.at ?? 0)).slice(0, MAX_TOUCHED)
    return Object.fromEntries(keep.map(k => [k, next[k] as Touch]))
  })
  if (before?.kind !== kind) await reveal($, file)
}

function ancestors(path: string, stop: string): string[] {
  const out: string[] = []
  for (let at = path.lastIndexOf('/'); at > stop.length; at = path.lastIndexOf('/', at - 1)) out.push(path.slice(0, at))
  return out
}

export const register: Register = (on, options) => {
  cfg.github = options.github === true
  cfg.ttl = Math.min(3600, Math.max(60, Number(options.githubRefreshSeconds) || 300))
  cfg.icons = options.icons === 'dot' || options.icons === 'none' ? options.icons : 'nerd'
  cfg.autoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'filetree',
      description: 'Show the file tree pane; /filetree close hides it',
    })
    const dir = await real($, e.cwd)
    await update($, root, () => dir)
    void refresh($)
    if (cfg.autoOpen) void $.ui.open({ id: PANE, title: 'Files' })

    return next(e)
  })

  on('command.run', { command: 'filetree' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'File tree closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Files' })
    void refresh($)

    return { text: 'File tree opened.' }
  })

  // A pure observer: the tool's result goes back untouched, and a failure in
  // the bookkeeping never reaches the model.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const kind = TOUCH[String(e.tool)]
      if (kind === 'bash') {
        await schedule($)
      } else if (kind && ran.deny === undefined && ran.isError !== true) {
        const input = e as { file_path?: string; notebook_path?: string }
        const path = input.file_path ?? input.notebook_path
        if (path) await touch($, path, kind)
        if (kind === 'write') await schedule($)
      }
    } catch {
      // bookkeeping only
    }

    return ran
  })

  on('classic.CwdChanged', async ($, e, next) => {
    await schedule($, 100).catch(() => undefined)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await schedule($, 100).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const q = await read($, query)
    const found_ = await read($, hits)
    const base = await read($, root)
    const listing = await read($, children)
    const opened = await read($, open)
    const marks = await read($, touched)
    const info = await read($, git)
    const found = await read($, pull)
    const flagged = await read($, guard)
    const view = await read($, peek)
    const pos = await read($, peekTop)

    const dirty = new Set<string>()
    const clash = new Set<string>()
    for (const [file, xy] of Object.entries(info?.files ?? {})) {
      for (const a of ancestors(file, base)) {
        dirty.add(a)
        if (CONFLICT.has(xy)) clash.add(a)
      }
    }
    const active = new Set<string>()
    for (const file of Object.keys(marks)) for (const a of ancestors(file, base)) active.add(a)

    const nerd = cfg.icons === 'nerd'
    const chevron = (isOpen: boolean) => (nerd ? (isOpen ? '' : '') : isOpen ? '▾' : '▸')
    // the glyph before a file name, in the colour of its type
    const mark = (name: string, dim: boolean) => {
      if (cfg.icons === 'none') return undefined
      const { nerd: glyph, color } = fileIcon(name)
      return <Text color={color} dimColor={dim}>{nerd ? glyph : '■'} </Text>
    }
    const rows: RenderChildren[] = []
    const walk = (dir: string, depth: number, under: boolean) => {
      const pad = '  '.repeat(depth)
      for (const entry of listing[dir] ?? []) {
        const path = `${dir}/${entry.name}`
        const name = clean(entry.name)
        const dim = under || info?.ignored[path] === true
        const code = info?.files[path]
        const touch = marks[path]
        const secret = touch !== undefined && entry.kind !== 'dir' && isSensitive(entry.name)
        const color = secret
          ? 'error'
          : touch
            ? touch.kind === 'write' ? 'claude' : 'suggestion'
            : entry.kind === 'dir'
              ? clash.has(path) ? 'error' : dirty.has(path) ? 'warning' : undefined
              : gitTone(code)
        const tag = (
          <Text>
            {secret ? <Text color="error"> ⚠</Text> : undefined}
            {code ? badges(code).map(([glyph, tone]) => <Text color={tone}> {glyph}</Text>) : undefined}
          </Text>
        )
        if (entry.kind === 'more') {
          rows.push(<Text dimColor>{pad}  {name}</Text>)
        } else if (entry.kind === 'dir') {
          const isOpen = opened[path] === true
          const note = isOpen
            ? undefined
            : clash.has(path)
              ? <Text color="error"> ✖</Text>
              : active.has(path)
                ? <Text color="suggestion"> ●</Text>
                : dirty.has(path)
                  ? <Text color="warning"> •</Text>
                  : undefined
          rows.push(
            <Button key={path} plain onPress={() => toggle($, path)}>
              {pad}{chevron(isOpen)} {nerd ? <Text color="#dcb67a" dimColor={dim}>{isOpen ? '' : ''} </Text> : undefined}<Text color={color} bold={!dim} dimColor={dim}>{name}</Text>{note}
            </Button>,
          )
          if (isOpen) walk(path, depth + 1, dim)
        } else {
          rows.push(
            <Button key={path} plain onPress={() => select($, path)}>
              {pad}  {mark(entry.name, dim)}<Text color={color} dimColor={dim || entry.kind === 'other'} bold={view?.path === path}>{name}</Text>{tag}
            </Button>,
          )
        }
      }
    }
    if (base) walk(base, 0, false)

    // a search replaces the tree with a flat list of matching files
    const searched = q.trim() !== ''
    const results: RenderChildren[] = []
    if (searched && base) {
      for (const rel of found_ ?? []) {
        const path = `${base}/${rel}`
        const cut = rel.lastIndexOf('/')
        const name = clean(cut < 0 ? rel : rel.slice(cut + 1))
        const folder = cut < 0 ? '' : clean(rel.slice(0, cut))
        const code = info?.files[path]
        results.push(
          <Button key={`hit:${rel}`} plain onPress={() => select($, path)}>
            {mark(name, false)}<Text color={gitTone(code)} bold={view?.path === path}>{name}</Text>
            {folder ? <Text dimColor> {folder}</Text> : undefined}
            {code ? badges(code).map(([glyph, tone]) => <Text color={tone}> {glyph}</Text>) : undefined}
          </Button>,
        )
      }
    }

    const where = !info
      ? 'not a git repository'
      : `⎇ ${info.detached ? `(detached ${info.oid})` : info.branch}${info.initial ? ' (no commits)' : !info.upstream && !info.detached ? ' (no upstream)' : ''}${info.ahead ? ` ↑${info.ahead}` : ''}${info.behind ? ` ↓${info.behind}` : ''}`
    const mine = cfg.github && info && found?.branch === info.branch ? found : undefined
    const TONE = { open: 'success', draft: undefined, merged: 'merged', closed: 'error' } as const
    const prLine =
      mine?.status === 'ok' && mine.number !== undefined && mine.state ? (
        <Text>
          PR #{mine.number} <Text color={TONE[mine.state]} dimColor={mine.state === 'draft'}>{mine.state}</Text>
          {mine.checks === 'pass' ? <Text color="success"> · CI ✔</Text> : undefined}
          {mine.checks === 'fail' ? <Text color="error"> · CI ✖</Text> : undefined}
          {mine.checks === 'pending' ? <Text color="warning"> · CI …</Text> : undefined}
          {mine.review === 'approved' ? <Text color="success"> · approved</Text> : undefined}
          {mine.review === 'changes' ? <Text color="error"> · changes requested</Text> : undefined}
          {mine.review === 'required' ? <Text color="warning"> · review needed</Text> : undefined}
        </Text>
      ) : mine?.status === 'none' && info?.upstream ? (
        <Text dimColor>no PR</Text>
      ) : mine?.status === 'error' ? (
        <Text dimColor>PR unavailable (gh)</Text>
      ) : undefined
    const room = e.props.scroll.bodyRows
    const cap = Math.max(6, Math.floor(room / 2) - 4)
    const top = view ? Math.min(pos, Math.max(0, view.lines.length - cap)) : 0
    const below = view ? Math.max(0, view.lines.length - (top + cap)) : 0
    const look = view ? (
      <Box flexDirection="column">
        <Text bold>
          {view.name}
          <Text dimColor> · {describe(view.code)}{view.kind === 'diff' ? ` · +${view.added} −${view.removed}` : ''}</Text>
        </Text>
        {view.note ? <Text dimColor>{view.note}</Text> : undefined}
        {top > 0 ? <Button key="peek-up" plain label={`▲ ${top} lines above`} onPress={() => update($, peekTop, () => Math.max(0, top - cap))} /> : undefined}
        {view.lines.slice(top, top + cap).map(l => (
          <Text color={view.kind === 'diff' ? (l.startsWith('+') ? 'success' : l.startsWith('-') ? 'error' : l.startsWith('@@') ? 'suggestion' : undefined) : undefined}>{l === '' ? ' ' : l}</Text>
        ))}
        {below > 0 ? <Button key="peek-down" plain label={`▼ ${below} more lines`} onPress={() => update($, peekTop, () => top + cap)} /> : undefined}
        {below === 0 && view.more > 0 ? <Text dimColor>… {view.more} more lines not loaded</Text> : undefined}
        <Button key="peek-close" label="✕ close preview" onPress={() => update($, peek, () => null)} />
        <Text dimColor>──────────</Text>
      </Box>
    ) : undefined
    const guarded = info !== null && !info.detached && PROTECTED.has(info.branch) && flagged[info.branch] === true
    const n = tally(info?.files ?? {})
    const summary = [
      n.conflicts ? <Text color="error">✖{n.conflicts} </Text> : undefined,
      n.staged ? <Text color="success">✚{n.staged} </Text> : undefined,
      n.changed ? <Text color="warning">●{n.changed} </Text> : undefined,
      n.untracked ? <Text color="success">?{n.untracked} </Text> : undefined,
      info?.stash ? <Text dimColor>⚑{info.stash} </Text> : undefined,
      info?.op ? <Text color="error">{info.op}</Text> : undefined,
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        <Text bold>{clean(base.split('/').pop() ?? base).toUpperCase()}</Text>
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Input key="search" label="⌕ " placeholder="Search files" value={q} onInput={v => void typed($, v)} onSubmit={v => void typed($, v, true)} />
          </Box>
          <Button key="refresh" plain label="↻" onPress={() => {
            prForce = true
            return refresh($)
          }} />
          <Button key="collapse" plain label="⊟" onPress={() => collapse($)} />
        </Box>
        <Text dimColor={!guarded} color={guarded ? 'error' : undefined}>
          {where}
          {guarded ? ' ⚠ Claude edited here' : ''}
        </Text>
        {summary.length > 0 && <Text>{summary}</Text>}
        {prLine}
        {look}
        {searched ? (
          found_ === null ? (
            <Text dimColor>Searching…</Text>
          ) : results.length === 0 ? (
            <Text dimColor>No matches.</Text>
          ) : (
            results
          )
        ) : rows.length === 0 ? (
          <Text dimColor>No files.</Text>
        ) : (
          rows
        )}
      </Box>
    )
  })
}
