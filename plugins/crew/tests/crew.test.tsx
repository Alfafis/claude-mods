import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, ctxPercent, ended, fmtTime, fmtTokens, plural, stepped, trim } from '../hooks/register'
import { frame, poseAt, shrink } from '../lib/dance'
import { UNSAFE, costOf, describeCall, fmtCost, hasTokens, meter, parsePrices, priceFor, redact, resultLine, roleColor, roleLabel, shortModel, stepCost } from '../lib/describe'
import { layout } from '../lib/tree'
import { COLUMNS, ROWS, costumeFor, sprite } from '../lib/sprites'
import type { Card } from '../types'

const PANE = {
  plugin: 'crew',
  component: 'Pane',
  requestId: 'crew',
  props: { title: 'Crew', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const blits: string[] = []
let refuseBlits = false

function world(on: On, opened: string[] = [], prefix = 'a', listing: () => unknown[] | undefined = () => undefined) {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('ui.blit', (_$, e) => {
    blits.push(e.key)
    return { value: refuseBlits ? { deny: 'not mounted' } : {} }
  })
  let n = 0
  const spawned: string[] = []
  on('agent.spawn', () => {
    const agentId = `${prefix}${++n}`
    spawned.push(agentId)
    return { model: 'claude-opus-5-5', agentId }
  })
  on('agent.list', () => ({ value: (listing() ?? spawned.map(id => ({ id, description: '', type: 'x', status: 'running' }))) as never }))
  return clock
}

const card = (id: string, over: Partial<Card> = {}): Card => ({ id, title: id, type: 'Plan', model: '', effort: '', status: 'running', steps: 0, ctx: 0, out: 0, inTok: 0, cacheR: 0, cacheW: 0, doing: '', result: '', startedAt: 0, lastAt: 0, endedAt: 0, ...over })

const cells = (b64: string) => new Uint32Array(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer)

test('formatters read tokens, time and context', () => {
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(31_000)).toBe('31k')
  expect(fmtTokens(3_200)).toBe('3.2k')
  expect(fmtTokens(120_400)).toBe('120k')
  expect(fmtTime(17_000)).toBe('0:17')
  expect(fmtTime(125_000)).toBe('2:05')
  expect(fmtTime(-5)).toBe('0:00')
  expect(ctxPercent(8000, 200_000)).toBe(4)
  expect(ctxPercent(900_000, 200_000)).toBe(100)
})

test('a sprite is fourteen columns by six rows of triplets, base64 whole', () => {
  const s = sprite('Explore', 'run', 0)
  expect(s.columns).toBe(COLUMNS)
  expect(s.rows).toBe(ROWS)
  expect([COLUMNS, ROWS]).toEqual([14, 6])
  expect(cells(s.cells).length).toBe(14 * 6 * 3)
})

test('cells are default-coloured spaces or half blocks, and the crab is not empty', () => {
  const w = cells(sprite('Plan', 'run', 0).cells)
  const codes = new Set<number>()
  for (let i = 0; i < w.length; i += 3) codes.add(w[i] as number)
  expect([...codes].every(c => c === 0x20 || c === 0x2580 || c === 0x2584)).toBe(true)
  expect(codes.has(0x2580)).toBe(true)
  // a blank cell is the terminal's own colours
  const blank = w.findIndex((v, i) => i % 3 === 0 && v === 0x20)
  expect(w[blank + 1]).toBe(0x01000000)
})

test('a running crab dances: its frames differ across the loop and repeat after 4 s', () => {
  const at = (ms: number) => sprite('Explore', 'run', ms).cells
  const frames = new Set([0, 500, 1000, 1500, 2000, 2500, 3000, 3500].map(at))
  expect(frames.size).toBeGreaterThan(3)
  expect(at(0)).toBe(at(4000))
  expect(at(1200)).toBe(at(5200))
})

test('a crab that is over stands still, and how it ended tints it', () => {
  const still = (ms: number) => sprite('Explore', 'done', ms).cells
  expect(still(0)).toBe(still(1500))
  expect(sprite('Explore', 'failed', 0).cells).not.toBe(still(0))
  expect(sprite('Explore', 'killed', 0).cells).not.toBe(still(0))
  expect(sprite('Explore', 'failed', 0).cells).not.toBe(sprite('Explore', 'killed', 0).cells)
})

test('agent types wear their own outfit; an unknown one keeps a stable one', () => {
  expect(costumeFor('Explore')).toBe('explore')
  expect(costumeFor('caveman:cavecrew-investigator')).toBe('explore')
  expect(costumeFor('Plan')).toBe('heavy')
  expect(costumeFor('opus-architect')).toBe('fable')
  expect(costumeFor('caveman:cavecrew-builder')).toBe('medium')
  expect(costumeFor('caveman:cavecrew-reviewer')).toBe('light')
  expect(costumeFor('general-purpose')).toBe('other')
  expect(costumeFor('My-Own-Agent')).toBe(costumeFor('my-own-agent'))
  expect(['doll', 'haiku', 'sonnet', 'careful', 'other']).toContain(costumeFor('whatever'))
})

test('every outfit has a routine and draws inside its window without throwing', () => {
  for (const c of ['fable', 'heavy', 'careful', 'doll', 'medium', 'light', 'haiku', 'sonnet', 'explore', 'other']) {
    for (let ms = 0; ms < 4000; ms += 250) {
      const g = shrink(frame(c, poseAt(c, ms), -2, 0, 36, 30), 36, 30, 2.5)
      expect(g.px.some(v => v !== undefined)).toBe(true)
    }
  }
  // an outfit the art does not know falls back to the plain crab
  expect(shrink(frame('nope', poseAt('nope', 0), -2, 0, 36, 30), 36, 30, 2.5).px.some(v => v !== undefined)).toBe(true)
})

test('the pose is held until the next key, and the loop wraps', () => {
  expect(poseAt('other', 0)).toEqual(poseAt('other', 4000))
  expect(poseAt('other', -1)).toEqual(poseAt('other', 3999))
})

test('trim drops the oldest finished cards and never a running one', () => {
  const all: Record<string, Card> = {}
  for (let i = 0; i < 40; i++) {
    all[`f${i}`] = { id: `f${i}`, title: '', type: '', model: '', effort: '', status: 'done', steps: 0, ctx: 0, out: 0, doing: '', result: '', startedAt: i, lastAt: i, endedAt: i + 1 }
  }
  all.live = { ...all.f0!, id: 'live', status: 'running', endedAt: 0 }
  const out = trim(all)
  expect(Object.keys(out).length).toBe(30)
  expect(out.live).toBeDefined()
  expect(out.f1).toBeUndefined()
})

test('the first subagent opens the pane once and its card shows up', async ($, on) => {
  const opened: string[] = []
  world(on, opened)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Review the kit', subagentType: 'Explore' })
  await $.agent.spawn({ prompt: 'y', description: 'Again', subagentType: 'Explore' })
  expect(opened).toEqual(['crew'])
  for (const surface of ['terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Running · 2/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'view:a1' }))?.text).toContain('Review the kit')
    expect(await ui.find({ type: 'Raster', key: 'art:a1' })).toBeDefined()
    await ui.unmount()
  }
})

test('autoOpen off leaves the pane to the command', { options: { autoOpen: false } }, async ($, on) => {
  const opened: string[] = []
  world(on, opened)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'a', subagentType: 'Plan' })
  expect(opened).toEqual([])
  const res = await $.command.run({ command: 'crew', args: '' })
  expect(res.text).toContain('opened')
  expect(opened).toEqual(['crew'])
})

test('an empty roster says so', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

const USAGE = { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 6000, cache_creation_input_tokens: 1000 }

test('a step adds up output, keeps the last prompt size and reads model and effort', () => {
  const card: Card = { id: 'a1', title: '', type: 'Explore', model: '', effort: '', status: 'running', steps: 0, ctx: 0, out: 0, doing: '', result: '', startedAt: 0, lastAt: 0, endedAt: 0 }
  const once = stepped(card, { model: 'claude-opus-5-5', effort: 'xhigh' }, USAGE)
  const twice = stepped(once, { model: 'claude-opus-5-5' }, { ...USAGE, cache_read_input_tokens: 9000 })
  expect(once).toMatchObject({ steps: 1, ctx: 8000, out: 500, model: 'claude-opus-5-5', effort: 'xhigh' })
  // the second prompt is bigger: ctx follows the last one, output adds, effort stays
  expect(twice).toMatchObject({ steps: 2, ctx: 11_000, out: 1000, effort: 'xhigh' })
  // a step with no usage still counts and keeps what was known
  expect(stepped(twice, { model: '' }, null)).toMatchObject({ steps: 3, ctx: 11_000, out: 1000, model: 'claude-opus-5-5' })
  expect(stepped(card, { model: 'm', effort: 3 }, null).effort).toBe('3')
})

test('how a turn ended picks the card status', () => {
  expect(ended('answer')).toBe('done')
  expect(ended('aborted')).toBe('killed')
  expect(ended('error')).toBe('failed')
  expect(ended('refusal')).toBe('failed')
})

test('turn.complete moves a card to Finished, aborted or failed turns say so', async ($, on) => {
  world(on, [], 'b')
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (const t of ['Explore', 'Plan', 'general-purpose']) await $.agent.spawn({ prompt: 'x', description: t, subagentType: t })
  const done = (agentId: string, reason: 'answer' | 'aborted' | 'error') =>
    $.turn.complete({ turnId: `t-${agentId}`, answer: '', durationMs: 5, isAborted: reason === 'aborted', agentId, reason })
  await done('b1', 'answer')
  await done('b2', 'aborted')
  await done('b3', 'error')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Finished · 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'view:b1' }))?.text).toContain('✓')
  expect((await ui.find({ type: 'Button', key: 'view:b2' }))?.text).toContain('■')
  expect((await ui.find({ type: 'Button', key: 'view:b3' }))?.text).toContain('✖')
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /Finished/ })).toBeUndefined()
  await ui.unmount()
})

test('the elapsed time moves while an agent runs and stops when it ends', async ($, on) => {
  const clock = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Timer', subagentType: 'Plan' })
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /0:03/ }))?.text).toContain('0:03')
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 3000, isAborted: false, agentId: 'a1', reason: 'answer' })
  await clock.advance(5000)
  expect((await ui.find({ type: 'Text', text: /0:0\d/ }))?.text).toContain('0:03')
  await ui.unmount()
})

test('an agent the engine reports as killed leaves "running" even with no turn.complete', async ($, on) => {
  let status = 'running'
  const clock = world(on, [], 'a', () => [{ id: 'a1', description: 'x', type: 'Plan', status }])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Lost', subagentType: 'Plan' })
  await clock.advance(1000)
  status = 'killed'
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'view:a1' }))?.text).toContain('■')
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  await ui.unmount()
})

test('the bar is full when over and a sweeping light while running', () => {
  expect(bar(20, 'done', 7)).toEqual({ before: 0, seg: 20, after: 0 })
  expect(bar(20, 'failed', 0)).toEqual({ before: 0, seg: 20, after: 0 })
  const frames = Array.from({ length: 60 }, (_, i) => bar(20, 'running', i))
  for (const f of frames) {
    expect(f.before + f.seg + f.after).toBe(20)
    expect(f.before).toBeGreaterThanOrEqual(0)
    expect(f.after).toBeGreaterThanOrEqual(0)
  }
  // it moves, and it bounces back rather than wrapping
  expect(new Set(frames.map(f => f.before)).size).toBeGreaterThan(5)
  expect(bar(20, 'running', 0).before).toBe(0)
  expect(bar(2, 'running', 5)).toEqual({ before: 0, seg: 2, after: 0 })
  expect(bar(0, 'running', 1)).toEqual({ before: 0, seg: 0, after: 0 })
})

test('one step is singular', () => {
  expect(plural(1, 'step')).toBe('1 step')
  expect(plural(0, 'step')).toBe('0 steps')
  expect(plural(4, 'step')).toBe('4 steps')
})

test('while an agent runs its crab is blitted four times a second, and not once it is over', async ($, on) => {
  blits.length = 0
  const clock = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Dance', subagentType: 'Explore' })
  await clock.advance(250)
  await clock.advance(250)
  expect(blits.length).toBeGreaterThan(0)
  expect(new Set(blits)).toEqual(new Set(['art:a1']))
  await $.turn.complete({ turnId: 't', answer: '', durationMs: 1, isAborted: false, agentId: 'a1', reason: 'answer' })
  await clock.advance(1000)
  const after = blits.length
  await clock.advance(2000)
  expect(blits.length).toBe(after)
})

test('describeCall says what a tool call is doing, short and clean', () => {
  expect(describeCall({ tool: 'Read', file_path: '/a/b/register.tsx' })).toBe('Read register.tsx')
  expect(describeCall({ tool: 'Edit', file_path: '/a/b/x.ts' })).toBe('Edit x.ts')
  expect(describeCall({ tool: 'Bash', command: 'git log --oneline\n -5' })).toBe('Bash git log --oneline -5')
  expect(describeCall({ tool: 'Bash', command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(5 + 36)
  expect(describeCall({ tool: 'Bash', command: 'a\u001b[31mb' })).not.toContain('\u001b')
  expect(describeCall({ tool: 'Grep', pattern: 'pulse' })).toBe('Grep pulse')
  expect(describeCall({ tool: 'WebFetch', url: 'https://github.com/x/y' })).toBe('WebFetch github.com/x/y')
  expect(describeCall({ tool: 'Agent', description: 'Scan it' })).toBe('Agent Scan it')
  expect(describeCall({ tool: 'mcp__x__y' })).toBe('mcp__x__y')
  expect(describeCall({ tool: 'Read' })).toBe('Read')
})

test('resultLine takes the first real line of an answer, without markdown marks', () => {
  expect(resultLine('## Resumo\n\n**13** testes passam')).toBe('Resumo')
  expect(resultLine('\n\n- `a.ts` faz x')).toBe('a.ts faz x')
  expect(resultLine('')).toBe('')
  expect(resultLine('y'.repeat(300)).length).toBe(90)
  expect(resultLine('ok\u0007\u001b[0m fim')).not.toMatch(/[\u0000-\u001f]/)
})

test('a role is a short word, and an unknown type shows its own name', () => {
  expect(roleLabel('Explore')).toBe('EXPLORE')
  expect(roleLabel('Plan')).toBe('PLAN')
  expect(roleLabel('opus-architect')).toBe('ARCHITECT')
  expect(roleLabel('caveman:cavecrew-builder')).toBe('BUILD')
  expect(roleLabel('caveman:cavecrew-reviewer')).toBe('REVIEW')
  expect(roleLabel('general-purpose')).toBe('GENERAL')
  expect(roleLabel('statusline-setup')).toBe('STATUSLIN…')
  expect(roleLabel('my-agent')).toBe('MY-AGENT')
  expect(roleLabel('')).toBe('AGENT')
  expect(roleColor('Explore')).toBe('#888780')
  expect(roleColor('Plan')).toBe('#D85A30')
  expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5-5')
  expect(shortModel('claude-opus-5-5[1m]')).toBe('opus-5-5')
})

test('the context meter fills in eighths and always shows a trace once there is any', () => {
  expect(meter(0)).toEqual({ full: 0, empty: 8 })
  expect(meter(1)).toEqual({ full: 1, empty: 7 })
  expect(meter(50)).toEqual({ full: 4, empty: 4 })
  expect(meter(100)).toEqual({ full: 8, empty: 0 })
  expect(meter(250)).toEqual({ full: 8, empty: 0 })
})

test('a card shows its role, what it is doing now, and what it answered', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Scan the kit', subagentType: 'Explore' })
  await $.tool.call({ tool: 'Read', file_path: '/p/hooks/register.tsx', agentId: 'a1' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'view:a1' }))?.text).toContain('EXPLORE')
  expect((await ui.find({ type: 'Button', key: 'view:a1' }))?.text).toContain('Scan the kit')
  expect(await ui.find({ type: 'Text', text: /↳ Read register\.tsx/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 agent · out 0/ })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ turnId: 't', answer: '## Done\nall good', durationMs: 5, isAborted: false, agentId: 'a1', reason: 'answer' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /↳/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /→ Done/ })).toBeDefined()
  await ui.unmount()
})

test('a tool call of the main loop leaves no card and the call is untouched', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Read', file_path: '/p/x.ts' })
  expect(ran.isError).not.toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('with no pane mounted the loop slows to once a second, then wakes when one is', async ($, on) => {
  blits.length = 0
  refuseBlits = true
  const clock = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Unseen', subagentType: 'Plan' })
  await clock.advance(500)
  blits.length = 0
  await clock.advance(5000)
  // five seconds at one probe a second, not twenty frames of four
  expect(blits.length).toBeLessThanOrEqual(6)
  refuseBlits = false
  await clock.advance(2000)
  blits.length = 0
  await clock.advance(1000)
  // seen again: back to four frames a second (three of the four are blits, the 4th a redraw)
  expect(blits.length).toBeGreaterThanOrEqual(2)
  refuseBlits = false
})

test('a spawn right as the last agent ends is not left without its loop', async ($, on) => {
  blits.length = 0
  const clock = world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'One', subagentType: 'Plan' })
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, agentId: 'a1', reason: 'answer' })
  await clock.advance(1500)
  await $.agent.spawn({ prompt: 'y', description: 'Two', subagentType: 'Plan' })
  blits.length = 0
  await clock.advance(1000)
  expect(blits.filter(k => k === 'art:a2').length).toBeGreaterThan(0)
})

test('text an agent chose cannot reorder, hide or redraw a card', () => {
  const rlo = 'rm \u202e txt.exe \u2066x\u2069 a\u200bb \ufeffc \u2028d'
  expect(describeCall({ tool: 'Bash', command: rlo })).not.toMatch(UNSAFE)
  expect(resultLine(rlo)).not.toMatch(UNSAFE)
  expect('a\u202eb\u001b[0m'.replace(UNSAFE, '?')).toBe('a?b?[0m')
})

test('a cut never splits a character outside the basic plane', () => {
  const out = describeCall({ tool: 'Bash', command: `${'a'.repeat(34)}🙂bbbb` })
  expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  expect(out.endsWith('…')).toBe(true)
})

test('a Windows path shows its file name', () => {
  expect(describeCall({ tool: 'Read', file_path: 'C:\\proj\\src\\a.ts' })).toBe('Read a.ts')
})

test('a credential never reaches the card: commands, searches, URLs and answers', () => {
  expect(describeCall({ tool: 'Bash', command: 'curl -H "Authorization: Bearer abc123def456ghi789" x' })).not.toContain('abc123')
  expect(describeCall({ tool: 'Bash', command: 'export API_KEY=supersecretvalue1234' })).not.toContain('supersecret')
  expect(describeCall({ tool: 'Bash', command: 'git push https://user:pw@github.com/x' })).not.toContain('pw@')
  expect(describeCall({ tool: 'Grep', pattern: 'ghp_abcdefghijklmnop' })).not.toContain('ghp_abc')
  expect(describeCall({ tool: 'WebFetch', url: 'https://x.dev/p?api_key=SECRET123#tok' })).toBe('WebFetch x.dev/p')
  expect(describeCall({ tool: 'WebFetch', url: 'https://user:pw@x.dev/p' })).toBe('WebFetch x.dev/p')
  expect(resultLine('A chave é sk-abcdefghijklmnop1234')).not.toContain('sk-abc')
  expect(redact('nothing to hide here')).toBe('nothing to hide here')
})

test('resultLine keeps underscores inside names and drops emphasis around words', () => {
  expect(resultLine('usa my_var_name e outra_coisa')).toBe('usa my_var_name e outra_coisa')
  expect(resultLine('isto é _importante_ de verdade')).toBe('isto é importante de verdade')
  expect(resultLine('**negrito** e `code`')).toBe('negrito e code')
  expect(resultLine(undefined)).toBe('')
  expect(resultLine(null)).toBe('')
  expect(resultLine(42)).toBe('')
})

test('meter survives a percentage that is not a number', () => {
  expect(meter(Number.NaN)).toEqual({ full: 0, empty: 8 })
  expect(meter(Number.POSITIVE_INFINITY)).toEqual({ full: 0, empty: 8 })
})

test('a late event never brings back a card that was cleared', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Gone', subagentType: 'Plan' })
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, agentId: 'a1', reason: 'answer' })
  await $.command.run({ command: 'crew', args: 'clear' })
  await $.turn.complete({ turnId: 't2', answer: 'late', durationMs: 1, isAborted: false, agentId: 'a1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('turn.complete keeps the first end time when settle got there before it', async ($, on) => {
  let status = 'running'
  const clock = world(on, [], 'a', () => [{ id: 'a1', description: 'x', type: 'Plan', status }])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Race', subagentType: 'Plan' })
  await clock.advance(1000)
  status = 'failed'
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /\d:\d\d/ }))?.text).toContain('0:02')
  await clock.advance(5000)
  await $.turn.complete({ turnId: 't', answer: 'late ok', durationMs: 1, isAborted: false, agentId: 'a1', reason: 'answer' })
  expect((await ui.find({ type: 'Text', text: /\d:\d\d/ }))?.text).toContain('0:02')
  expect((await ui.find({ type: 'Button', key: 'view:a1' }))?.text).toContain('✓')
  await ui.unmount()
})

test('a running card the engine stops listing is taken as lost after a few checks', async ($, on) => {
  let listed = true
  const clock = world(on, [], 'a', () => (listed ? [{ id: 'a1', description: 'x', type: 'Plan', status: 'running' }] : []))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Vanish', subagentType: 'Plan' })
  await clock.advance(2000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  listed = false
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  // absent for a few checks but not yet quiet for long enough: still running
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  await clock.advance(8000)
  expect(await ui.find({ type: 'Text', text: /Running/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'view:a1' }))?.text).toContain('■')
  await ui.unmount()
})

test('an agent missing from the list but still active is never taken as lost', async ($, on) => {
  const clock = world(on, [], 'a', () => [])
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Busy', subagentType: 'Plan' })
  for (let i = 0; i < 8; i++) {
    await $.tool.call({ tool: 'Read', file_path: '/p/x.ts', agentId: 'a1' })
    await clock.advance(2000)
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  await ui.unmount()
})

test('a step also adds up the input tokens, uncached and through the cache', () => {
  const c0 = card('a1', { type: 'Explore' })
  const c1 = stepped(c0, { model: 'm' }, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 6000, cache_creation_input_tokens: 1000 })
  const c2 = stepped(c1, { model: 'm' }, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 })
  expect(c2).toMatchObject({ inTok: 1010, cacheR: 15000, cacheW: 1000, out: 505 })
  expect(stepped(c2, { model: 'm' }, null)).toMatchObject({ inTok: 1010, cacheR: 15000, cacheW: 1000 })
})

test('prices come only from the person: parsed entry by entry, matched by the longest name', () => {
  expect(parsePrices('')).toEqual({})
  expect(parsePrices('not json')).toEqual({})
  expect(parsePrices('[1,2]')).toEqual({})
  expect(parsePrices('{"a": {"in": 1}, "b": {"in": -1, "out": 2}, "c": {"in": "x", "out": 2}, "": {"in": 1, "out": 1}}')).toEqual({})
  const table = parsePrices('{"Opus": {"in": 15, "out": 75}, "opus-5-5": {"in": 5, "out": 25, "cacheR": 0.5, "cacheW": 6}, "bad": null}')
  expect(Object.keys(table).sort()).toEqual(['opus', 'opus-5-5'])
  expect(priceFor(table, 'claude-opus-5-5[1m]')).toEqual({ in: 5, out: 25, cacheR: 0.5, cacheW: 6 })
  expect(priceFor(table, 'claude-opus-4')).toEqual({ in: 15, out: 75 })
  expect(priceFor(table, 'claude-haiku-5-5')).toBeUndefined()
  expect(priceFor({}, 'anything')).toBeUndefined()
})

test('cost is tokens times the price per million; a cache price left out is the input price', () => {
  const c = card('a1', { inTok: 1_000_000, out: 100_000, cacheR: 2_000_000, cacheW: 500_000 })
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  expect(near(costOf(c, { in: 3, out: 15, cacheR: 0.3, cacheW: 3.75 }), 3 + 1.5 + 0.6 + 1.875)).toBe(true)
  // a read left out costs as input, a write left out as 1.25 times input
  expect(near(costOf(c, { in: 3, out: 15 }), 3 + 1.5 + 6 + 1.875)).toBe(true)
  expect(hasTokens(card('x'))).toBe(false)
  expect(hasTokens(card('x', { cacheR: 1 }))).toBe(true)
  expect(fmtCost(0)).toBe('<$0.01')
  expect(fmtCost(0.004)).toBe('<$0.01')
  expect(fmtCost(0.126)).toBe('~$0.13')
  expect(fmtCost(9.994)).toBe('~$9.99')
  expect(fmtCost(12.4)).toBe('~$12')
})

test('a step costs what its tokens come to at the price of the model that ran it', () => {
  const p = { in: 10, out: 50, cacheR: 1, cacheW: 12.5 }
  const u = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 100_000 }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  expect(stepCost(u, p).tokens).toBe(true)
  expect(stepCost(u, p).priced).toBe(true)
  expect(near(stepCost(u, p).cost, 10 + 5 + 2 + 1.25)).toBe(true)
  // tokens but no price: counted as unpriced, no cost
  expect(stepCost(u, undefined)).toEqual({ cost: 0, tokens: true, priced: false })
  // no tokens: nothing to price, however the price looks
  expect(stepCost(null, p)).toEqual({ cost: 0, tokens: false, priced: false })
  expect(stepCost({ input_tokens: 'x', output_tokens: Number.NaN }, p)).toEqual({ cost: 0, tokens: false, priced: false })
})

test('an agent that changes model is charged each step at that step\'s own price', () => {
  const cheap = { in: 1, out: 5 }
  const dear = { in: 10, out: 50 }
  const u = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  let c = card('a1')
  c = stepped(c, { model: 'claude-haiku-5-5' }, u, cheap)
  expect(near(c.costUsd ?? -1, 1 + 0.5)).toBe(true)
  c = stepped(c, { model: 'claude-opus-5-5' }, u, dear)
  // the first step keeps its cheap price: 1.5 + 15, not 2 x 15 and not 2 x 1.5
  expect(near(c.costUsd ?? -1, 1.5 + 10 + 5)).toBe(true)
  expect(c.unpriced).toBeUndefined()
  // a step with tokens and no price makes the figure a floor, and keeps what was priced
  c = stepped(c, { model: 'claude-other' }, u, undefined)
  expect(near(c.costUsd ?? -1, 16.5)).toBe(true)
  expect(c.unpriced).toBe(true)
  // a card that never had a price has no cost at all
  expect(stepped(card('b'), { model: 'm' }, u, undefined).costUsd).toBeUndefined()
  expect(stepped(card('b'), { model: 'm' }, u, undefined).unpriced).toBe(true)
  // a step with no usage changes nothing about cost
  expect(stepped(c, { model: 'm' }, null, dear).costUsd).toBe(c.costUsd)
})

test('layout nests a child under its parent, newest block first, and keeps a parent in view while a child runs', () => {
  const all: Record<string, Card> = {
    p: card('p', { startedAt: 1, status: 'done' }),
    c1: card('c1', { startedAt: 5, parentId: 'p' }),
    c2: card('c2', { startedAt: 3, parentId: 'p', status: 'done' }),
    g: card('g', { startedAt: 6, parentId: 'c1' }),
    solo: card('solo', { startedAt: 9, status: 'done' }),
  }
  const { running, finished } = layout(all)
  expect(running.map(r => [r.card.id, r.depth])).toEqual([['p', 0], ['c2', 1], ['c1', 1], ['g', 2]])
  expect(finished.map(r => [r.card.id, r.depth])).toEqual([['solo', 0]])
})

test('layout takes an orphan, a self-parent and a cycle as roots and never loops', () => {
  const all: Record<string, Card> = {
    o: card('o', { parentId: 'missing', startedAt: 1 }),
    s: card('s', { parentId: 's', startedAt: 2 }),
    x: card('x', { parentId: 'y', startedAt: 3 }),
    y: card('y', { parentId: 'x', startedAt: 4 }),
  }
  const { running, finished } = layout(all)
  const ids = [...running, ...finished].map(r => r.card.id).sort()
  expect(ids).toEqual(['o', 's', 'x', 'y'])
  expect(new Set(ids).size).toBe(4)
})

test('layout flattens when grouping is off, and caps the depth', () => {
  const all: Record<string, Card> = { a: card('a', { startedAt: 1 }), b: card('b', { startedAt: 2, parentId: 'a' }) }
  expect(layout(all, false).running.map(r => r.depth)).toEqual([0, 0])
  const chain: Record<string, Card> = {}
  for (let i = 0; i < 10; i++) chain[`n${i}`] = card(`n${i}`, { startedAt: i, ...(i > 0 ? { parentId: `n${i - 1}` } : {}) })
  expect(Math.max(...layout(chain).running.map(r => r.depth))).toBe(4)
})

test('a subagent spawned by another is drawn under it, indented', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Parent', subagentType: 'Plan' })
  await $.agent.spawn({ prompt: 'y', description: 'Child', subagentType: 'Explore', parentAgentId: 'a1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Box', key: 'card:a1' }))?.props.paddingLeft).toBe(0)
  expect((await ui.find({ type: 'Box', key: 'card:a2' }))?.props.paddingLeft).toBe(2)
  expect((await ui.find({ type: 'Button', key: 'view:a2' }))?.text).toContain('└')
  await ui.unmount()
})

test('groupByParent off draws every agent at the margin', { options: { groupByParent: false } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Parent', subagentType: 'Plan' })
  await $.agent.spawn({ prompt: 'y', description: 'Child', subagentType: 'Explore', parentAgentId: 'a1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Box', key: 'card:a2' }))?.props.paddingLeft).toBe(0)
  expect((await ui.find({ type: 'Button', key: 'view:a2' }))?.text).not.toContain('└')
  await ui.unmount()
})

test('compactFinished draws a finished agent in two lines with no mascot, and a running one in full', { options: { compactFinished: true } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Done one', subagentType: 'Explore' })
  await $.agent.spawn({ prompt: 'y', description: 'Still going', subagentType: 'Plan' })
  await $.turn.complete({ turnId: 't', answer: 'All good here', durationMs: 5, isAborted: false, agentId: 'a1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'art:a1' })).toBeUndefined()
  expect(await ui.find({ type: 'Raster', key: 'art:a2' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'view:a1' }))?.text).toContain('Done one')
  expect(await ui.find({ type: 'Text', text: /→ All good here/ })).toBeDefined()
  await ui.unmount()
})

test('finished cards keep the full card and the mascot by default', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Done one', subagentType: 'Explore' })
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 5, isAborted: false, agentId: 'a1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster', key: 'art:a1' })).toBeDefined()
  await ui.unmount()
})

test('maxCards sets how many cards are kept, and never drops a running one', { options: { maxCards: 5 } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 8; i++) await $.agent.spawn({ prompt: 'x', description: `n${i}`, subagentType: 'Plan' })
  // all eight run: the limit is soft
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running · 8/ })).toBeDefined()
  await ui.unmount()
  for (let i = 1; i <= 7; i++) await $.turn.complete({ turnId: `t${i}`, answer: 'ok', durationMs: 1, isAborted: false, agentId: `a${i}`, reason: 'answer' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Running · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Finished · 4/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'view:a8' })).toBeDefined()
  await ui.unmount()
})

test('trim honours a limit given to it', () => {
  const all: Record<string, Card> = {}
  for (let i = 0; i < 10; i++) all[`f${i}`] = card(`f${i}`, { status: 'done', endedAt: i + 1 })
  all.live = card('live')
  expect(Object.keys(trim(all, 4)).length).toBe(4)
  expect(trim(all, 4).live).toBeDefined()
  expect(Object.keys(trim(all, 50)).length).toBe(11)
})

test('with prices set but no tokens yet, no cost shows on the pane', { options: { prices: '{"opus": {"in": 10, "out": 50}}' } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Quiet', subagentType: 'Plan' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\$/ })).toBeUndefined()
  await ui.unmount()
})

test('prices: unsafe names, wildcard names, wrong cache prices and absurd values are dropped, a BOM is not', () => {
  expect(parsePrices('{"__proto__": {"in": 1, "out": 1}, "constructor": {"in": 1, "out": 1}}')).toEqual({})
  expect(Object.getPrototypeOf(parsePrices('{"__proto__": {"in": 1, "out": 1}}'))).toBe(Object.prototype)
  expect(parsePrices('{"o": {"in": 1, "out": 1}, "-": {"in": 1, "out": 1}, "--": {"in": 1, "out": 1}, "  ": {"in": 1, "out": 1}}')).toEqual({})
  expect(Object.keys(parsePrices('{"abc": {"in": 1, "out": 1}}'))).toEqual(['abc'])
  // a cache price that is there and wrong drops the entry; one that is absent does not
  expect(parsePrices('{"opus": {"in": 1, "out": 2, "cacheR": "x"}}')).toEqual({})
  expect(parsePrices('{"opus": {"in": 1, "out": 2, "cacheW": -1}}')).toEqual({})
  expect(parsePrices('{"opus": {"in": 1, "out": 2, "cacheR": null}}')).toEqual({})
  expect(parsePrices('{"opus": {"in": 1, "out": 2}}')).toEqual({ opus: { in: 1, out: 2 } })
  expect(parsePrices('{"opus": {"in": 1e308, "out": 1}}')).toEqual({})
  expect(parsePrices('{"free": {"in": 0, "out": 0}}')).toEqual({ free: { in: 0, out: 0 } })
  expect(parsePrices('{"opus": [1, 2]}')).toEqual({})
  expect(parsePrices('\ufeff{"opus": {"in": 1, "out": 2}}')).toEqual({ opus: { in: 1, out: 2 } })
  expect(parsePrices('{"opus": {"in": 1, "out": 2}} trailing')).toEqual({})
})

test('prices set but unusable raise a warning on the pane; no prices and good prices do not', { options: { prices: '{"x": 1}' } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /prices: no usable entry/ })).toBeDefined()
  await ui.unmount()
})

test('no warning when prices are left empty', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /prices: no usable entry/ })).toBeUndefined()
  await ui.unmount()
})

test('a parent id that names something on Object.prototype is no parent at all', () => {
  const all: Record<string, Card> = {
    a: card('a', { startedAt: 1, parentId: 'constructor' }),
    b: card('b', { startedAt: 2, parentId: '__proto__' }),
    c: card('c', { startedAt: 3, parentId: 'toString' }),
  }
  const { running } = layout(all)
  expect(running.map(r => [r.card.id, r.depth])).toEqual([['c', 0], ['b', 0], ['a', 0]])
})

test('clear drops what the pane lists under Finished and keeps a finished child of a running parent', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Parent', subagentType: 'Plan' })
  await $.agent.spawn({ prompt: 'y', description: 'Child', subagentType: 'Explore', parentAgentId: 'a1' })
  await $.agent.spawn({ prompt: 'z', description: 'Loner', subagentType: 'Explore' })
  await $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 1, isAborted: false, agentId: 'a2', reason: 'answer' })
  await $.turn.complete({ turnId: 't3', answer: 'ok', durationMs: 1, isAborted: false, agentId: 'a3', reason: 'answer' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Finished · 1/ })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Button', key: 'view:a3' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'view:a2' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'view:a1' })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, agentId: 'a1', reason: 'answer' })
  const res = await $.command.run({ command: 'crew', args: 'clear' })
  expect(res.text).toContain('cleared')
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})

test('a pane with no column count still draws', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({ prompt: 'x', description: 'Narrow', subagentType: 'Plan' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: undefined as never }, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'view:a1' })).toBeDefined()
  await ui.unmount()
})

test('a usage field that is missing or not a number counts as zero and never makes a NaN', () => {
  const odd = { input_tokens: undefined, output_tokens: Number.NaN, cache_read_input_tokens: 'x', cache_creation_input_tokens: null } as never
  const c = stepped(card('a1'), { model: 'm' }, odd)
  expect(c).toMatchObject({ inTok: 0, out: 0, cacheR: 0, cacheW: 0, ctx: 0, steps: 1 })
  const bad = { ...card('b'), inTok: Number.NaN, out: Number.POSITIVE_INFINITY }
  expect(costOf(bad, { in: 1, out: 1 })).toBe(0)
  expect(hasTokens(bad)).toBe(false)
  expect(fmtCost(Number.NaN)).toBe('<$0.01')
  expect(stepCost({ input_tokens: undefined, output_tokens: Number.NaN }, { in: 10, out: 50 }).cost).toBe(0)
})
