import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import { UNSAFE, describeCall, fmtCost, meter, parsePrices, priceFor, resultLine, roleColor, roleLabel, shortModel, stepCost } from '../lib/describe'
import type { Price, PriceTable } from '../lib/describe'
import { COLUMNS, ROWS, sprite } from '../lib/sprites'
import { layout } from '../lib/tree'
import type { Row } from '../lib/tree'
import type { Card, Status } from '../types'

const PANE = 'crew'
// The crabs move at 4 frames a second, painted in place; the text and the engine's list are
// refreshed every 4th frame, once a second.
const FRAME_MS = 250
const TEXT_EVERY = 4

const roster = atom({ plugin: 'crew', key: 'roster' } as const, {} as Record<string, Card>, { shape: 'roster-4' })
const tick = atom({ plugin: 'crew', key: 'tick' } as const, 0, { shape: 'tick-1' })
// Which of the loops that drive the crabs is the latest.
const loopId = atom({ plugin: 'crew', key: 'loopId' } as const, 0, { shape: 'loop-1' })
// What the session's subagents cost, at the price of the model of each step. A card leaving the
// roster (maxCards, clear) takes nothing from it.
const spent = atom({ plugin: 'crew', key: 'spent' } as const, { sum: 0, partial: false, any: false }, { shape: 'spent-1' })

const cfg = { autoOpen: true, window: 200_000, maxCards: 30, compact: false, group: true, prices: {} as PriceTable, pricesBad: false }

let ticking = false
let opened = false

const clean = (s: string) => s.replace(UNSAFE, '?')

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function ctxPercent(ctx: number, window: number): number {
  return Math.min(100, Math.round((ctx / window) * 100))
}

// The bar under a card: full once the agent is over, a light that sweeps while
// it runs (the engine gives no total, so there is no fraction to show).
export function bar(width: number, status: Status, beat: number): { before: number; seg: number; after: number } {
  if (status !== 'running') return { before: 0, seg: width, after: 0 }
  const seg = Math.min(width, Math.max(3, Math.floor(width / 5)))
  const room = width - seg
  if (room <= 0) return { before: 0, seg: width, after: 0 }
  const at = (beat * 2) % (room * 2)
  const before = at <= room ? at : room * 2 - at
  return { before, seg, after: room - before }
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const TONE: Record<Status, string | undefined> = { running: 'suggestion', done: 'success', failed: 'error', killed: undefined }
const MARK: Record<Status, string> = { running: '●', done: '✓', failed: '✖', killed: '■' }

function blank(id: string, now: number): Card {
  return { id, title: '', type: '', model: '', effort: '', status: 'running', steps: 0, ctx: 0, out: 0, inTok: 0, cacheR: 0, cacheW: 0, doing: '', result: '', startedAt: now, lastAt: now, endedAt: 0 }
}

// Oldest finished cards go first, so a long session never grows the list.
export function trim(all: Record<string, Card>, max = cfg.maxCards): Record<string, Card> {
  const ids = Object.keys(all)
  if (ids.length <= max) return all
  const gone = ids
    .filter(id => all[id]!.status !== 'running')
    .sort((a, b) => all[a]!.endedAt - all[b]!.endedAt)
    .slice(0, ids.length - max)
  const next = { ...all }
  for (const id of gone) delete next[id]
  return next
}

// The engine's clock, not Date.now(): a test moves it, and elapsed time follows.
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

// A usage field that is missing or not a number counts as zero.
const tokens = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)

// One model request of an agent's loop: the prompt size is the last one, output adds up, and the
// cost adds at the price of the model that ran this step (`price`, when there is one).
export function stepped(c: Card, step: { model: string; effort?: string | number }, u: Usage | null, price?: Price): Card {
  const cost = stepCost(u, price)
  return {
    ...c,
    model: clean(step.model) || c.model,
    effort: step.effort === undefined ? c.effort : String(step.effort),
    steps: c.steps + 1,
    ctx: u ? tokens(u.input_tokens) + tokens(u.cache_read_input_tokens) + tokens(u.cache_creation_input_tokens) : c.ctx,
    out: c.out + tokens(u?.output_tokens),
    inTok: c.inTok + tokens(u?.input_tokens),
    cacheR: c.cacheR + tokens(u?.cache_read_input_tokens),
    cacheW: c.cacheW + tokens(u?.cache_creation_input_tokens),
    ...(cost.priced ? { costUsd: (c.costUsd ?? 0) + cost.cost } : {}),
    ...(cost.tokens && !cost.priced ? { unpriced: true } : {}),
  }
}

export function ended(reason: string): Status {
  return reason === 'answer' ? 'done' : reason === 'aborted' ? 'killed' : 'failed'
}

// `create`: a card for an agent the roster does not know yet (a spawn, or a running agent that
// started before the mod loaded). A late event never brings back a card that was cleared.
async function patch($: EngineInterface, id: string, change: (c: Card) => Card, create = true): Promise<void> {
  const now = await $.clock.now()
  await update($, roster, all => {
    const known = all[id]
    if (!known && !create) return all
    return trim({ ...all, [id]: { ...change(known ?? blank(id, now)), lastAt: now } })
  })
}

// An agent that started before the mod loaded has no card: fill its title and
// type from the engine's own list.
async function adopt($: EngineInterface, id: string): Promise<void> {
  const known = (await read($, roster))[id]
  if (known?.type) return
  const found = (await $.agent.list().catch(() => [])).find(a => a.id === id)
  if (!found) return
  await patch($, id, c => ({ ...c, title: clean(found.description), type: clean(found.type), parentId: found.parentId ?? c.parentId }))
}

// How many settles in a row a running card was missing from the engine's list.
const missing = new Map<string, number>()
const LOST_AFTER = 3
const QUIET_MS = 10_000

// An agent can end without a turn.complete (killed, its loop lost): the engine's own list is the
// check, so no card stays "running" for good. One the list stops reporting is taken as lost.
async function settle($: EngineInterface): Promise<void> {
  const open_ = Object.values(await read($, roster)).filter(c => c.status === 'running')
  const alive = new Set(open_.map(c => c.id))
  for (const id of [...missing.keys()]) if (!alive.has(id)) missing.delete(id)
  if (open_.length === 0) return
  const listed = await $.agent.list().catch(() => undefined)
  if (!listed) return
  const now = await $.clock.now()
  const known = new Map(listed.map(a => [a.id, a.status]))
  const over: Record<string, Status> = {}
  for (const c of open_) {
    const status = known.get(c.id)
    if (status === undefined) {
      // missing from the list is not proof: it also takes a stretch with no sign of life
      const n = (missing.get(c.id) ?? 0) + 1
      missing.set(c.id, n)
      if (n >= LOST_AFTER && now - c.lastAt > QUIET_MS) over[c.id] = 'killed'
      continue
    }
    missing.delete(c.id)
    if (status === 'completed') over[c.id] = 'done'
    else if (status === 'failed') over[c.id] = 'failed'
    else if (status === 'killed') over[c.id] = 'killed'
  }
  const ids = Object.keys(over)
  if (ids.length === 0) return
  await update($, roster, all => {
    const next = { ...all }
    for (const id of ids) {
      const c = next[id]
      if (c?.status !== 'running') continue
      next[id] = { ...c, status: over[id]!, endedAt: now, doing: '', result: over[id] === 'done' ? c.result : over[id] === 'killed' ? 'stopped' : 'ended with an error' }
      missing.delete(id)
    }
    return next
  })
}

// Drives the crabs while something runs and stops when nothing does. A frame is a blit of each
// running crab's cells, no redraw of the pane; every 4th one also settles the cards against the
// engine's list and redraws the pane, which is when the elapsed time moves. With no pane mounted
// (never opened, or closed) every blit is refused: the loop then slows to once a second, only
// settling the cards and probing with a blit, so nothing paints for nobody.
//
// Each loop holds a number kept in `$.state`, which a reload does not reset: a loop that finds
// another number there is not the latest and stops, so a reload or a restart never leaves two.
async function pulse($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  await update($, loopId, n => n + 1)
  const me = await read($, loopId)
  let n = 0
  let seen = true
  const running = async () => Object.values(await read($, roster)).filter(c => c.status === 'running')
  const step = async (): Promise<void> => {
    try {
      if ((await read($, loopId)) !== me) return
      const whole = n++ % TEXT_EVERY === 0
      if (whole || !seen) await settle($).catch(() => undefined)
      const live = await running()
      if (live.length === 0) {
        ticking = false
        // a spawn that landed in this gap started no loop of its own: look once more
        if ((await running()).length === 0) return
        ticking = true
      }
      if (seen && whole) await update($, tick, k => k + 1)
      else {
        const now = await $.clock.now()
        const probe = seen ? live : live.slice(0, 1)
        const done = await Promise.all(
          probe.map(c => {
            try {
              return $.ui.blit({ requestId: PANE, key: `art:${c.id}`, cells: sprite(c.type || 'agent', 'run', now - c.startedAt).cells }).catch(() => ({ deny: 'failed' }))
            } catch {
              return { deny: 'failed' }
            }
          }),
        )
        seen = done.some(r => !r.deny)
      }
      await $.clock.after(seen ? FRAME_MS : 1000, () => void step())
    } catch {
      // the session can end or reload under a frame in flight; rearm unless a newer loop owns it
      ticking = false
    }
  }
  await step()
}

async function open($: EngineInterface): Promise<void> {
  opened = true
  await $.ui.open({ id: PANE, title: 'Crew' })
}

// What "clear" drops is what the pane lists under Finished: a finished child of an agent that is
// still running is shown under it, in Running, and stays.
const dropFinished = (all: Record<string, Card>) => {
  const gone = new Set(layout(all, cfg.group).finished.map(r => r.card.id))
  return Object.fromEntries(Object.entries(all).filter(([id]) => !gone.has(id)))
}

export const register: Register = (on, options) => {
  cfg.autoOpen = options.autoOpen !== false
  cfg.window = Math.max(8000, Number(options.contextWindow) || 200_000)
  cfg.maxCards = Math.min(200, Math.max(5, Math.floor(Number(options.maxCards)) || 30))
  cfg.compact = options.compactFinished === true
  cfg.group = options.groupByParent !== false
  const priceText = typeof options.prices === 'string' ? options.prices : ''
  cfg.prices = parsePrices(priceText)
  cfg.pricesBad = priceText.trim() !== '' && Object.keys(cfg.prices).length === 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'crew', description: 'Show the subagent pane; /crew close hides it, /crew clear drops the finished cards' })
    return next(e)
  })

  on('command.run', { command: 'crew' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Crew closed.' }
    }
    if (arg === 'clear') {
      await update($, roster, dropFinished)
      return { text: 'Finished cards cleared.' }
    }
    await open($)
    return { text: 'Crew opened.' }
  })

  // Observer: the spawn's answer goes back untouched.
  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    try {
      if (res.agentId) {
        const id = res.agentId
        const now = await $.clock.now()
        await patch($, id, c => ({ ...c, title: clean(e.description), type: clean(e.subagentType), model: clean(res.model ?? ''), status: 'running', startedAt: now, parentId: e.parentAgentId ?? c.parentId }))
        if (cfg.autoOpen && !opened) await open($)
        void pulse($)
      }
    } catch {
      // bookkeeping only
    }
    return res
  })

  // A streaming event: the chunks pass through untouched, the result is read.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)
    const id = e.agentId
    if (id === undefined) return res
    try {
      const price = priceFor(cfg.prices, e.model)
      await patch($, id, c => stepped(c, e, res.usage, price))
      const cost = stepCost(res.usage, price)
      if (cost.tokens) await update($, spent, t => ({ sum: t.sum + cost.cost, partial: t.partial || !cost.priced, any: t.any || cost.priced }))
      await adopt($, id)
      void pulse($)
    } catch {
      // bookkeeping only
    }
    return res
  })

  // Observer: what a subagent is calling shows on its card; the call itself is never touched.
  on('tool.call', async ($, e, next) => {
    const id = (e as { agentId?: string }).agentId
    if (id !== undefined) {
      try {
        const doing = describeCall(e as never)
        await patch($, id, c => ({ ...c, doing }))
      } catch {
        // bookkeeping only
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    const id = e.agentId
    if (id === undefined) return res
    try {
      const status = ended(e.reason)
      const now = await $.clock.now()
      const result = status === 'done' ? resultLine(e.answer) : status === 'killed' ? 'stopped' : 'ended with an error'
      await patch($, id, c => ({ ...c, status, endedAt: c.endedAt || now, doing: '', result }), false)
    } catch {
      // bookkeeping only
    }
    return res
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    const all = await read($, roster)
    const beat = await read($, tick)
    const now = await $.clock.now()
    const cards = Object.values(all)
    const { running, finished } = layout(all, cfg.group)
    const columns = Number(e.props.bodyColumns) || 60
    const width = Math.max(8, columns - COLUMNS - 2)

    // what a card has to say in its second line, shared by the full and the compact form
    const facts = (c: Card) => {
      const pct = ctxPercent(c.ctx, cfg.window)
      const cost = c.costUsd === undefined ? '' : `${fmtCost(c.costUsd)}${c.unpriced ? '+' : ''}`
      const what = c.status === 'running' ? (c.doing ? `↳ ${c.doing}` : '↳ starting…') : c.result ? `→ ${c.result}` : ''
      const span = (c.status === 'running' ? now : c.endedAt) - c.startedAt
      return { pct, cost, what, span }
    }
    const head = (c: Card, depth: number, time?: string) => (
      <Button key={`view:${c.id}`} plain onPress={() => $.ui.view({ agentId: c.id })}>
        {depth > 0 ? <Text dimColor>└ </Text> : undefined}
        <Text bold color={TONE[c.status]}>{MARK[c.status]} </Text>
        <Text bold color="#14161a" backgroundColor={roleColor(c.type || 'agent')}> {roleLabel(c.type || 'agent')} </Text>
        <Text bold wrap="truncate-end"> {c.title || c.id.slice(0, 8)}</Text>
        {time ? <Text dimColor> · {time}</Text> : undefined}
      </Button>
    )

    const draw = ({ card: c, depth }: Row): RenderChildren => {
      const art = sprite(c.type || 'agent', c.status === 'running' ? 'run' : c.status === 'done' ? 'done' : c.status, now - c.startedAt)
      const { pct, cost, what, span } = facts(c)
      const gauge = meter(pct)
      const hot = pct >= 90 ? 'error' : pct >= 70 ? 'warning' : undefined
      const line = bar(Math.max(8, width - depth * 2), c.status, beat)
      return (
        <Box key={`card:${c.id}`} flexDirection="row" gap={1} paddingLeft={depth * 2}>
          <Raster key={`art:${c.id}`} columns={art.columns} rows={art.rows} cells={art.cells} />
          <Box flexDirection="column" justifyContent="center" height={ROWS}>
            {head(c, depth)}
            <Text color={c.status === 'running' ? 'suggestion' : undefined} dimColor={c.status !== 'running'} wrap="truncate-end">{what || ' '}</Text>
            <Text dimColor wrap="truncate-end">
              ctx <Text color={hot}>{'▰'.repeat(gauge.full)}{'▱'.repeat(gauge.empty)} {pct}%</Text> · out {fmtTokens(c.out)}{cost ? ` · ${cost}` : ''} · {plural(c.steps, 'step')}
            </Text>
            <Text dimColor wrap="truncate-end">
              {[shortModel(c.model), c.effort].filter(Boolean).join(' · ') || '…'} · <Text bold dimColor={false}>{fmtTime(span)}</Text>
            </Text>
            <Text color={TONE[c.status]} dimColor={c.status === 'killed'} wrap="truncate-end">
              <Text dimColor>{'─'.repeat(line.before)}</Text>
              {'━'.repeat(line.seg)}
              <Text dimColor>{'─'.repeat(line.after)}</Text>
            </Text>
          </Box>
        </Box>
      )
    }

    // two lines, no mascot: a finished agent that does not need the room
    const drawCompact = ({ card: c, depth }: Row): RenderChildren => {
      const { pct, cost, what, span } = facts(c)
      return (
        <Box key={`card:${c.id}`} flexDirection="column" paddingLeft={depth * 2}>
          {head(c, depth, fmtTime(span))}
          <Text dimColor wrap="truncate-end">
            {'  '}
            {what ? `${what} · ` : ''}ctx {pct}% · out {fmtTokens(c.out)}
            {cost ? ` · ${cost}` : ''}
          </Text>
        </Box>
      )
    }

    const total = await read($, spent)
    const cash = total.any ? ` · ${fmtCost(total.sum)}${total.partial ? '+' : ''}` : ''

    return (
      <Box flexDirection="column" gap={1}>
        {cards.length === 0 ? <Text dimColor>No subagents yet.</Text> : <Text dimColor>{plural(cards.length, 'agent')} · out {fmtTokens(cards.reduce((n, c) => n + c.out, 0))}{cash}</Text>}
        {cfg.pricesBad ? <Text color="warning" wrap="truncate-end">prices: no usable entry (JSON with in and out per model)</Text> : undefined}
        {running.length > 0 ? <Text bold>Running · {running.filter(r => r.card.status === 'running').length}</Text> : undefined}
        {running.map(r => (r.card.status === 'running' || !cfg.compact ? draw(r) : drawCompact(r)))}
        {finished.length > 0 ? (
          <Box flexDirection="row" gap={1}>
            <Text bold>Finished · {finished.length}</Text>
            <Button key="clear" plain label="clear" dimColor onPress={() => update($, roster, dropFinished)} />
          </Box>
        ) : undefined}
        {finished.map(cfg.compact ? drawCompact : draw)}
      </Box>
    )
  })
}
