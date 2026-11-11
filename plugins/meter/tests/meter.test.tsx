import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { base, crossing, fmtTok, fmtUsd, gauge, growth, label, resetsIn, snapshot, spark, tone, windowName } from '../lib/format'
import { toReading } from '../hooks/register'

const PANE = {
  plugin: 'meter',
  component: 'Pane',
  requestId: 'meter',
  props: { title: 'Context', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = (over: Record<string, unknown> = {}) =>
  ({
    plugin: 'meter',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, ...over },
  }) as never

type Box = { usage: unknown; toasts: string[]; opened: string[] }

const CATS = [
  { name: 'System prompt', tokens: 9000, color: 'x', isDeferred: false, kind: 'used' },
  { name: 'Messages', tokens: 38_000, color: 'x', isDeferred: false, kind: 'used' },
  { name: 'Memory files', tokens: 5000, color: 'x', isDeferred: false, kind: 'used' },
  { name: 'Free space', tokens: 120_000, color: 'x', isDeferred: false, kind: 'free' },
  { name: 'Autocompact buffer', tokens: 30_000, color: 'x', isDeferred: false, kind: 'buffer' },
]

const usage = (over: Record<string, unknown> = {}) => ({
  startedAt: 0,
  context: {
    tokens: 68_000,
    window: 200_000,
    percent: 34,
    breakdown: {
      categories: CATS,
      totalTokens: 52_000,
      rawMaxTokens: 200_000,
      model: 'claude-sonnet-5-5',
      memoryFiles: [
        { path: '/p/CLAUDE.md', type: 'Project', tokens: 3000 },
        { path: '/Users/x/.claude/CLAUDE.md', type: 'User', tokens: 2000 },
      ],
    },
  },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-11T14:30:00Z' },
    { kind: 'seven_day', percentUsed: 7 },
  ],
  cost: { usd: 1.234 },
  ...over,
})

function world(on: On, box: Box) {
  const clock = mock.clock(on, { now: Date.parse('2026-11-11T12:00:00Z') })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    box.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: {} }))
  on('ui.toast', (_$, e) => {
    box.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.usage', () => ({ value: box.usage as never }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  return clock
}

const fresh = (): Box => ({ usage: usage(), toasts: [], opened: [] })

test('spark draws each value as tall as its share, and an empty or odd one as the floor', () => {
  expect(spark([0, 50, 100])).toBe('▁▄█')
  expect(spark([])).toBe('')
  expect(spark([Number.NaN, -5, 1000])).toBe('▁▁█')
  expect(spark([0.5, 1], 1)).toBe('▄█')
})

test('money and tokens read short', () => {
  expect(fmtUsd(0)).toBe('<$0.01')
  expect(fmtUsd(0.004)).toBe('<$0.01')
  expect(fmtUsd(1.234)).toBe('$1.23')
  expect(fmtUsd(9.994)).toBe('$9.99')
  expect(fmtUsd(12.4)).toBe('$12')
  expect(fmtUsd(Number.NaN)).toBe('<$0.01')
  expect(fmtTok(0)).toBe('0')
  expect(fmtTok(950)).toBe('950')
  expect(fmtTok(31_000)).toBe('31k')
  expect(fmtTok(3200)).toBe('3.2k')
  expect(fmtTok(120_400)).toBe('120k')
  expect(fmtTok(Number.NaN)).toBe('0')
})

test('gauge fills in eighths, shows a trace for any share above zero and survives odd input', () => {
  expect(gauge(0)).toEqual({ full: 0, empty: 8 })
  expect(gauge(1)).toEqual({ full: 1, empty: 7 })
  expect(gauge(50)).toEqual({ full: 4, empty: 4 })
  expect(gauge(100)).toEqual({ full: 8, empty: 0 })
  expect(gauge(250)).toEqual({ full: 8, empty: 0 })
  expect(gauge(Number.NaN)).toEqual({ full: 0, empty: 8 })
  expect(gauge(50, 10)).toEqual({ full: 5, empty: 5 })
})

test('the colour turns warning at the line and error ten points past it', () => {
  expect(tone(50, 80)).toBeUndefined()
  expect(tone(80, 80)).toBe('warning')
  expect(tone(89, 80)).toBe('warning')
  expect(tone(90, 80)).toBe('error')
  expect(tone(99, 95)).toBe('error')
})

test('the warning fires once per climb and arms again ten points below the line', () => {
  expect(crossing(false, 79, 80)).toEqual({ warn: false, warned: false })
  expect(crossing(false, 80, 80)).toEqual({ warn: true, warned: true })
  expect(crossing(true, 95, 80)).toEqual({ warn: false, warned: true })
  expect(crossing(true, 75, 80)).toEqual({ warn: false, warned: true })
  expect(crossing(true, 69, 80)).toEqual({ warn: false, warned: false })
  expect(crossing(false, undefined, 80)).toEqual({ warn: false, warned: false })
  expect(crossing(false, Number.NaN, 80)).toEqual({ warn: false, warned: false })
})

test('growth tells what each category gained since the last snapshot', () => {
  const cats = CATS.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind as 'used' }))
  const before = snapshot(cats.map(c => ({ ...c, tokens: c.name === 'Messages' ? 30_000 : c.tokens })))
  const out = growth(before, cats)
  expect(out.Messages).toBe(8000)
  expect(out['System prompt']).toBe(0)
  // a category the snapshot never had grew by nothing, not by all of it
  expect(growth({}, cats).Messages).toBe(0)
})

test('a reset reads as a distance, and a window as its short name', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  expect(resetsIn('2026-11-11T12:35:00Z', now)).toBe('35m')
  expect(resetsIn('2026-11-11T14:10:00Z', now)).toBe('2h 10m')
  expect(resetsIn('2026-11-15T12:00:00Z', now)).toBe('4d')
  expect(resetsIn('2026-11-11T11:00:00Z', now)).toBe('now')
  expect(resetsIn(undefined, now)).toBe('')
  expect(resetsIn('nonsense', now)).toBe('')
  expect(windowName('five_hour')).toBe('5h')
  expect(windowName('seven_day')).toBe('7d')
  expect(windowName('spend_limit')).toBe('spend')
  expect(windowName('some_new_window')).toBe('some new window')
})

test('a name from the engine is one printable line, cut by character', () => {
  expect(label('a\u202eb\u001b[0m  c')).toBe('a b [0m c')
  expect(label('x'.repeat(40), 10).length).toBe(10)
  expect(label(`${'a'.repeat(9)}🙂bbb`, 10)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  expect(base('C:\\proj\\CLAUDE.md')).toBe('CLAUDE.md')
  expect(base('/a/b/c.md')).toBe('c.md')
})

test('toReading keeps what is a number and drops the rest', () => {
  const r = toReading(usage() as never)
  expect(r).toEqual({
    window: 200_000,
    pct: 34,
    tokens: 68_000,
    usd: 1.234,
    limits: [
      { kind: 'five_hour', pct: 23.5, resetsAt: '2026-11-11T14:30:00Z' },
      { kind: 'seven_day', pct: 7 },
    ],
  })
  const odd = toReading({ context: { window: Number.NaN, percent: 'x', tokens: undefined }, rateLimits: [{ kind: 'five_hour', percentUsed: Number.NaN }], cost: { usd: Number.POSITIVE_INFINITY } } as never)
  expect(odd).toEqual({ window: 0, limits: [] })
})

test('/meter opens the pane and fills it with the window by category, memory files, cost and limits', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const res = await $.command.run({ command: 'meter', args: '' })
  expect(res.text).toContain('opened')
  expect(box.opened).toContain('meter')
  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Context 34%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /68k of 200k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Messages/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /System prompt/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Free space/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Autocompact buffer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CLAUDE\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /session \$1\.23/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h.*24%.*resets in 2h 30m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7d.*7%/ })).toBeDefined()
    await ui.unmount()
  }
  const closed = await $.command.run({ command: 'meter', args: 'close' })
  expect(closed.text).toContain('closed')
})

test('the biggest category comes first, and free space and the buffer stay below the used ones', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const known = ['Messages', 'System prompt', 'Memory files', 'Free space', 'Autocompact buffer']
  const names = (await ui.findAll({ type: 'Text', text: /^(System prompt|Messages|Memory files|Free space|Autocompact buffer)\s+▰/ })).map(n => known.find(k => n.text.startsWith(k))!)
  expect(names.slice(0, 3)).toEqual(['Messages', 'System prompt', 'Memory files'])
  expect(names.slice(3)).toEqual(['Free space', 'Autocompact buffer'])
  await ui.unmount()
})

test('the line above the prompt shows context, session cost and the windows', { options: { band: true } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const line = (await ui.find({ type: 'Text', text: /ctx/ }))?.text ?? ''
  expect(line).toContain('34%')
  expect(line).toContain('session $1.23')
  expect(line).toContain('5h 24%')
  expect(line).toContain('7d 7%')
  await ui.unmount()
})

test('the line yields to a survey, and says nothing before the engine has reported', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
  await $.command.run({ command: 'meter', args: '' })
  ui = await $.ui.mount({ ...BAND({ hasSurvey: true }), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('band off leaves the line out and the pane in', { options: { band: false } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  let ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Context 34%/ })).toBeDefined()
  await ui.unmount()
})

test('limits off drops the windows from the line and from the pane', { options: { limits: false } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  let ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(((await ui.find({ type: 'Text', text: /ctx/ }))?.text ?? '')).not.toContain('5h')
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /resets in/ })).toBeUndefined()
  await ui.unmount()
})

test('a turn of the main conversation records its cost and the context it left, and a subagent turn does not', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  box.usage = usage({ cost: { usd: 1.0 } })
  await $.turn.start({ text: 'go', turnId: 't1' })
  box.usage = usage({ cost: { usd: 1.25 }, context: { ...usage().context, percent: 40 } })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  // a subagent's turn in between: not the meter's own turn (its cost is in the session's total)
  await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' })
  await $.turn.complete({ turnId: 's1', answer: '', durationMs: 5, isAborted: false, agentId: 'a1', reason: 'answer' })
  await $.turn.start({ text: 'again', turnId: 't2' })
  box.usage = usage({ cost: { usd: 1.75 }, context: { ...usage().context, percent: 55 } })
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /per turn ▄▅/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last turn \$/ })).toBeDefined()
  const cost = (await ui.find({ type: 'Text', text: /^session \$/ }))?.text ?? ''
  expect(cost).toContain('last turn $0.50')
  expect(cost).toContain('$0.38 a turn over 2')
  await ui.unmount()
})

test('what a category gained over the last turn is shown next to it', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const bigger = { ...usage().context.breakdown, categories: CATS.map(c => (c.name === 'Messages' ? { ...c, tokens: 44_500 } : c)) }
  box.usage = usage({ context: { ...usage().context, breakdown: bigger } })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^Messages/ }))?.text).toContain('+6.5k')
  await ui.unmount()
})

test('the context warning fires once when the share passes the line, and again after it falls', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const measure = (percent: number) =>
    $.session.measure({ context: { tokens: percent * 2000, window: 200_000, percent }, rateLimits: [], changed: ['context'] } as never)
  await measure(60)
  await measure(79)
  expect(box.toasts).toEqual([])
  await measure(83)
  expect(box.toasts.length).toBe(1)
  expect(box.toasts[0]).toContain('83%')
  await measure(90)
  await measure(95)
  expect(box.toasts.length).toBe(1)
  await measure(60)
  await measure(82)
  expect(box.toasts.length).toBe(2)
})

test('warnAt moves the line', { options: { warnAt: 60 } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 130_000, window: 200_000, percent: 65 }, rateLimits: [], changed: ['context'] } as never)
  expect(box.toasts.length).toBe(1)
})

test('a measurement keeps the line current without a call to the engine', { options: { band: true } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 40_000, window: 200_000, percent: 20 }, rateLimits: [], cost: { usd: 0.5 }, changed: ['context', 'cost'] } as never)
  const ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  const line = (await ui.find({ type: 'Text', text: /ctx/ }))?.text ?? ''
  expect(line).toContain('20%')
  expect(line).toContain('session $0.50')
  await ui.unmount()
})

test('an engine that fails the usage call leaves the pane empty and nothing thrown', async ($, on) => {
  const box = fresh()
  world(on, box)
  box.usage = undefined
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /no turn finished yet/ })).toBeDefined()
  await ui.unmount()
})

test('two measurements raised together toast once', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const at = (percent: number) => $.session.measure({ context: { tokens: percent * 2000, window: 200_000, percent }, rateLimits: [], changed: ['context'] } as never)
  await Promise.all([at(85), at(86), at(87)])
  expect(box.toasts.length).toBe(1)
})

test('a toast that is refused never becomes an unhandled rejection', async ($, on) => {
  const box = fresh()
  const clock = world(on, box)
  void clock
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], changed: ['context'] } as never)
  expect(box.toasts.length).toBe(1)
})

test('a breakdown with parts missing still fills the line and leaves the pane readable', { options: { band: true } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  box.usage = usage({ context: { tokens: 40_000, window: 200_000, percent: 20, breakdown: { totalTokens: 1, rawMaxTokens: 200_000 } } })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  let ui = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(((await ui.find({ type: 'Text', text: /ctx/ }))?.text ?? '')).toContain('20%')
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Context 20%/ })).toBeDefined()
  await ui.unmount()
  // memory files and a model name missing
  box.usage = usage({ context: { tokens: 40_000, window: 200_000, percent: 20, breakdown: { categories: CATS, totalTokens: 52_000, rawMaxTokens: 200_000 } } })
  await $.command.run({ command: 'meter', args: '' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Messages/ })).toBeDefined()
  await ui.unmount()
})

test('the line is off unless asked for, and the pane and the warning still work', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], changed: ['context'] } as never)
  const band = await $.ui.mount({ ...BAND(), surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await band.unmount()
  expect(box.toasts.length).toBe(1)
})

test('with a compaction window smaller than the model window, share, header and warning all speak of it', { options: { band: true } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  box.usage = usage({ context: { tokens: 207_000, window: 1_000_000, percent: 21, breakdown: { categories: CATS, totalTokens: 207_000, rawMaxTokens: 700_000, model: 'm', memoryFiles: [] } } })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'meter', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Context 30%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /207k of 700k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /model holds 1000k/ })).toBeDefined()
  await ui.unmount()
  expect(box.toasts.length).toBe(0)
  // 580k is 58% of the model window, but past 80% of the window autocompact acts on
  await $.session.measure({ context: { tokens: 580_000, window: 1_000_000, percent: 58 }, rateLimits: [], changed: ['context'] } as never)
  expect(box.toasts.length).toBe(1)
})

test('toReading keeps the engine share when the compaction window is the model window or unknown', () => {
  const ctx = { tokens: 100_000, window: 200_000, percent: 50 }
  expect(toReading({ context: ctx, rateLimits: [] }, 200_000).pct).toBe(50)
  expect(toReading({ context: ctx, rateLimits: [] }).pct).toBe(50)
  expect(toReading({ context: ctx, rateLimits: [] }, 200_000).modelWindow).toBeUndefined()
  const small = toReading({ context: ctx, rateLimits: [] }, 125_000)
  expect(small.pct).toBe(80)
  expect(small.window).toBe(125_000)
  expect(small.modelWindow).toBe(200_000)
})

test('the pane opens by itself at session start unless autoOpen is off', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(box.opened).toContain('meter')
})

test('autoOpen off leaves the pane to the command', { options: { autoOpen: false } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(box.opened).toEqual([])
  await $.command.run({ command: 'meter', args: '' })
  expect(box.opened).toEqual(['meter'])
})
