import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { base, compacted, crossing, fmtTok, fmtUsd, gauge, growth, label, resetsIn, snapshot, spark, tone, windowName } from '../lib/format'
import type { Cat, Crumbs, Limit, Reading, Turn } from '../types'

const PANE = 'meter'
const KEEP = 16
const ROWS = 8

const reading = atom({ plugin: 'meter', key: 'reading' } as const, null as Reading | null, { shape: 'reading-1' })
const turns = atom({ plugin: 'meter', key: 'turns' } as const, [] as Turn[], { shape: 'turns-1' })
// What the session had cost when the turn in progress began.
const mark = atom({ plugin: 'meter', key: 'mark' } as const, null as number | null, { shape: 'mark-1' })
const crumbs = atom({ plugin: 'meter', key: 'crumbs' } as const, null as Crumbs | null, { shape: 'crumbs-1' })
// What each category held after the previous turn, to tell what this one added.
const snap = atom({ plugin: 'meter', key: 'snap' } as const, {} as Record<string, number>, { shape: 'snap-1' })
const warned = atom({ plugin: 'meter', key: 'warned' } as const, false, { shape: 'warned-1' })

const cfg = { band: true, limits: true, warnAt: 80, autoOpen: true }

// The window autocompact measures against, as the last breakdown said.
let compactMax: number | undefined

// Bumped by every measurement the engine pushes: a read that began before one must not overwrite it.
let measures = 0

let warnedMem = false
let warnedInit: Promise<boolean> | undefined
let warnedSeen = false

type Usage = {
  context: { tokens?: number; window: number; percent?: number; breakdown?: { categories: Cat[]; totalTokens: number; rawMaxTokens: number; model: string; memoryFiles: { path: string; type: string; tokens: number }[] } }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)

// `compact`: the window autocompact measures against, when it is smaller than the model's. The
// share and the window then both speak of it, since that is the line that matters.
export function toReading(u: { context: Usage['context']; rateLimits: Usage['rateLimits']; cost?: Usage['cost'] }, compact?: number): Reading {
  const limits: Limit[] = (u.rateLimits ?? []).flatMap(l => {
    const pct = num(l.percentUsed)
    return pct === undefined ? [] : [{ kind: String(l.kind), pct, ...(l.resetsAt ? { resetsAt: String(l.resetsAt) } : {}) }]
  })
  const model = num(u.context.window) ?? 0
  const tokens = num(u.context.tokens)
  const usd = num(u.cost?.usd)
  const smaller = compact !== undefined && compact > 0 && compact < model
  const window = smaller ? compact : model
  const pct = tokens !== undefined && smaller ? Math.max(0, (tokens / compact) * 100) : num(u.context.percent)
  return {
    window,
    ...(smaller ? { modelWindow: model } : {}),
    ...(pct === undefined ? {} : { pct }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(usd === undefined ? {} : { usd }),
    limits,
  }
}

// What the engine says about the window and the money, read now. `turn`: a turn just ended, so
// the window by category is compared with the one after the turn before.
async function take($: EngineInterface, ended = false): Promise<Reading | undefined> {
  const seen = measures
  const u = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)) as Usage | undefined
  if (!u) return undefined
  const b = u.context.breakdown
  compactMax = num(b?.rawMaxTokens) ?? compactMax
  const now = toReading(u, compactMax)
  if (measures === seen) await update($, reading, () => now)
  if (b && Array.isArray(b.categories)) {
    const cats: Cat[] = b.categories.map(c => ({ name: label(c.name, 24), tokens: Math.max(0, num(c.tokens) ?? 0), kind: c.kind }))
    // (a category row the engine sends without a name or a token count is still one row)
    const before = await read($, snap)
    const fresh = ended || Object.keys(before).length === 0
    const delta = fresh ? growth(before, cats) : ((await read($, crumbs))?.delta ?? {})
    const shrank = fresh ? compacted(before, cats) : ((await read($, crumbs))?.compacted ?? false)
    await update($, crumbs, () => ({
      cats,
      total: num(b.totalTokens) ?? 0,
      max: num(b.rawMaxTokens) ?? now.window,
      model: label(String(b.model ?? ''), 32),
      files: [...(Array.isArray(b.memoryFiles) ? b.memoryFiles : [])].sort((x, y) => y.tokens - x.tokens).slice(0, 5).map(f => ({ path: label(f.path, 80), type: label(f.type, 12), tokens: f.tokens })),
      delta,
      compacted: shrank,
    }))
    if (ended || Object.keys(before).length === 0) await update($, snap, () => snapshot(cats))
  }
  return now
}

async function open($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Context' })
  await take($)
}

export const register: Register = (on, options) => {
  cfg.band = options.band === true
  cfg.limits = options.limits !== false
  cfg.autoOpen = options.autoOpen !== false
  cfg.warnAt = Math.min(95, Math.max(50, Math.floor(Number(options.warnAt)) || 80))

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'meter', description: 'Show the context and cost pane; /meter close hides it' })
    if (cfg.autoOpen) void open($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'meter' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Context pane closed.' }
    }
    await open($)
    return { text: 'Context pane opened.' }
  })

  // Observer: the engine raises it whenever the context, a rate-limit window or the cost moved.
  // The warning state is decided before any await, so two measurements raised together cannot
  // both see "not warned yet" and toast twice; the atom only keeps it across a reload.
  on('session.measure', async ($, e, next) => {
    try {
      warnedInit ??= read($, warned)
      const stored = await warnedInit
      if (!warnedSeen) {
        warnedSeen = true
        warnedMem = stored
      }
      measures++
      const now = toReading(e, compactMax)
      const cross = crossing(warnedMem, now.pct, cfg.warnAt)
      const changed = cross.warned !== warnedMem
      warnedMem = cross.warned
      await update($, reading, () => now)
      if (changed) await update($, warned, () => cross.warned)
      if (cross.warn && now.pct !== undefined) void $.ui.toast(`Context at ${Math.round(now.pct)}%: compact or clear before autocompact starts to thrash`).catch(() => undefined)
    } catch {
      // bookkeeping only
    }
    return next(e)
  })

  // The main conversation only: a subagent's turns are the crew's.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const u = (await $.session.usage().catch(() => undefined)) as Usage | undefined
        await update($, mark, () => num(u?.cost?.usd) ?? null)
      } catch {
        // bookkeeping only
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) return res
    try {
      const now = await take($, true)
      if (now) {
        const start = await read($, mark)
        const usd = start !== null && now.usd !== undefined ? Math.max(0, now.usd - start) : 0
        await update($, turns, all => [...all, { pct: now.pct ?? 0, usd }].slice(-KEEP))
      }
    } catch {
      // bookkeeping only
    }
    return res
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, reading)
    if (!cfg.band || e.props.hasSurvey || !r || r.pct === undefined) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const history = await read($, turns)
    const last = history.at(-1)
    const g = gauge(r.pct)
    const hot = tone(r.pct, cfg.warnAt)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          ctx <Text color={hot}>{'▰'.repeat(g.full)}{'▱'.repeat(g.empty)} {Math.round(r.pct)}%</Text>
          {history.length > 1 ? ` ${spark(history.map(t => t.pct))}` : ''}
          {last ? ` · turn ${fmtUsd(last.usd)}` : ''}
          {r.usd !== undefined ? ` · session ${fmtUsd(r.usd)}` : ''}
          {cfg.limits ? r.limits.map(l => ` · ${windowName(l.kind)} ${Math.round(l.pct)}%`).join('') : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, reading)
    const b = await read($, crumbs)
    const history = await read($, turns)
    const now = await $.clock.now()
    const pct = r?.pct

    const used = (b?.cats ?? []).filter(c => c.kind === 'used').sort((x, y) => y.tokens - x.tokens).slice(0, ROWS)
    const rest = (b?.cats ?? []).filter(c => c.kind === 'free' || c.kind === 'buffer')
    const max = Math.max(1, b?.max ?? r?.window ?? 1)
    const row = (c: Cat, dim: boolean) => {
      const g = gauge((c.tokens / max) * 100, 10)
      const d = b?.delta[c.name] ?? 0
      return (
        <Text key={`cat:${c.name}`} dimColor={dim} wrap="truncate-end">
          {label(c.name, 18).padEnd(18)} {'▰'.repeat(g.full)}{'▱'.repeat(g.empty)} {fmtTok(c.tokens).padStart(6)} {String(Math.round((c.tokens / max) * 100)).padStart(3)}%
          {d >= 100 ? <Text color={d >= 2000 ? 'warning' : undefined}> +{fmtTok(d)}</Text> : undefined}
        </Text>
      )
    }

    const totalUsd = history.reduce((n, t) => n + t.usd, 0)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            Context {pct === undefined ? '—' : <Text color={tone(pct, cfg.warnAt)}>{Math.round(pct)}%</Text>}
            {r?.tokens !== undefined && r.window ? <Text dimColor> · {fmtTok(r.tokens)} of {fmtTok(r.window)}</Text> : undefined}
          </Text>
          {r?.modelWindow ? <Text dimColor wrap="truncate-end">autocompact window; the model holds {fmtTok(r.modelWindow)}</Text> : undefined}
          {history.length > 0 ? <Text dimColor>per turn {spark(history.map(t => t.pct))}</Text> : <Text dimColor>no turn finished yet</Text>}
          {b?.model ? <Text dimColor wrap="truncate-end">{b.model}</Text> : undefined}
        </Box>
        {used.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>By category <Text dimColor>(+ = grew over the last turn)</Text></Text>
            {b?.compacted ? <Text color="suggestion">compacted: the window shrank over the last turn</Text> : undefined}
            {used.map(c => row(c, false))}
            {rest.map(c => row(c, true))}
          </Box>
        ) : undefined}
        {b && b.files.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Memory files</Text>
            {b.files.map(f => (
              <Text key={`file:${f.path}`} dimColor wrap="truncate-end">{fmtTok(f.tokens).padStart(6)}  {base(f.path)} <Text dimColor>· {f.type}</Text></Text>
            ))}
          </Box>
        ) : undefined}
        <Box flexDirection="column">
          <Text bold>Cost</Text>
          <Text dimColor>
            {r?.usd !== undefined ? `session ${fmtUsd(r.usd)}` : 'no cost reported'}
            {history.length > 0 ? ` · last turn ${fmtUsd(history.at(-1)!.usd)} · ${fmtUsd(totalUsd / history.length)} a turn over ${history.length}` : ''}
          </Text>
          {history.length > 1 ? <Text dimColor>per turn {spark(history.map(t => t.usd), Math.max(0.01, ...history.map(t => t.usd)))}</Text> : undefined}
        </Box>
        {cfg.limits && r && r.limits.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Limits</Text>
            {r.limits.map(l => (
              <Text key={`limit:${l.kind}`} dimColor>
                {windowName(l.kind).padEnd(6)} <Text color={tone(l.pct, 80)}>{Math.round(l.pct)}%</Text>
                {l.resetsAt ? ` · resets in ${resetsIn(l.resetsAt, now)}` : ''}
              </Text>
            ))}
          </Box>
        ) : undefined}
        <Button key="refresh" plain label="↻ refresh" onPress={() => take($)} />
      </Box>
    )
  })
}
