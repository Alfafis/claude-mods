import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { encodeCwd, escapeRe, group, needleOf, parseHits, patternOf, redact, shortProject, tidy, when } from '../lib/search'

const HOME = '/Users/me'
const ROOT = `${HOME}/.claude/projects`
const CWD = '/Users/me/Code/my.app'
const DIR = `${ROOT}/${encodeCwd(CWD)}`

const PANE = {
  plugin: 'recall',
  component: 'Pane',
  requestId: 'recall',
  props: { title: 'Recall', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Box = { runs: { argv: string[]; env?: Record<string, string> }[]; stdout: string; exitCode: number; truncated: boolean; mtimes: Record<string, number>; broken: boolean; here: boolean }

const fresh = (): Box => ({ runs: [], stdout: '', exitCode: 0, truncated: false, mtimes: {}, broken: false, here: true })

function world(on: On, box: Box) {
  mock.clock(on, { now: Date.parse('2026-11-11T12:00:00Z') })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: {} }))
  on('session.id', () => ({ value: 'sess-now' }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : e.name === 'CLAUDE_CODE_EXECPATH' ? '/bin/claude' : undefined }))
  on('fs.exists', () => ({ value: box.here }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: 1, mtimeMs: box.mtimes[e.path] ?? 0, isLink: false } }))
  on('process.run', (_$, e) => {
    box.runs.push({ argv: [...e.argv], ...(e.init?.env ? { env: e.init.env } : {}) })
    if (box.broken) throw new Error('spawn ENOENT')
    return { value: { exitCode: box.exitCode, stdout: box.stdout, stderr: '', isStdoutTruncated: box.truncated, isStderrTruncated: false } }
  })
}

const line = (file: string, text: string) => `${file}:${text}\n`

test('the pattern escapes what a regex would read as syntax and matches the JSON-escaped text', () => {
  expect(escapeRe('a.b(c)[d]')).toBe('a\\.b\\(c\\)\\[d\\]')
  expect(needleOf('say "hi"')).toBe('say \\"hi\\"')
  expect(patternOf('a.b')).toBe('.{0,70}a\\.b.{0,70}')
  expect(patternOf('x"y')).toBe('.{0,70}x\\\\"y.{0,70}')
})

test('a project folder is named the way Claude Code names it', () => {
  expect(encodeCwd('/Users/me/Code/my.app')).toBe('-Users-me-Code-my-app')
  expect(shortProject('-Users-me-Code-my-app')).toBe('Code-my-app')
  expect(shortProject(`-Users-me-${'x'.repeat(60)}`)).toHaveLength(34)
})

test('a hit reads as one printable line, escapes undone, credentials hidden', () => {
  expect(tidy('say \\"hi\\" \\\\n done\\nnext \\u00e9 \\/x')).toBe('say "hi" \\n done next é /x')
  expect(tidy('a\u202eb\u0007c')).toBe('a b c')
  expect(tidy('Authorization: Bearer abcdef123456 end')).not.toContain('abcdef123456')
  expect(redact('postgres://user:hunter2@host/db')).not.toContain('hunter2')
  expect(redact('key ghp_abcdefghijklmnop1234')).not.toContain('ghp_abcdef')
  expect(tidy('x'.repeat(400), 20)).toHaveLength(20)
})

test('ripgrep lines become sessions: a subagent belongs to its session, a stray path is dropped', () => {
  const out =
    line(`${ROOT}/-p/aaa.jsonl`, 'one') +
    line(`${ROOT}/-p/bbb/subagents/agent-1.jsonl`, 'two') +
    line('/etc/passwd.jsonl', 'out') +
    line(`${ROOT}/-p/../../x.jsonl`, 'up') +
    'no separator here\n'
  const hits = parseHits(out, ROOT)
  expect(hits.map(h => [h.project, h.session, h.text])).toEqual([
    ['-p', 'aaa', 'one'],
    ['-p', 'bbb', 'two'],
  ])
})

test('hits group by session, three distinct lines at most, and the open session is left out', () => {
  const hits = ['a', 'a', 'b', 'c', 'd'].map(text => ({ project: '-p', session: 's1', file: '/f', text }))
  hits.push({ project: '-p', session: 'sess-now', file: '/g', text: 'self' }, { project: '-p', session: 's2', file: '/h', text: '   ' })
  const { found } = group(hits, 'sess-now')
  expect(found).toHaveLength(1)
  expect(found[0]!.texts).toEqual(['a', 'b', 'c'])
})

test('a line every session opens with is boilerplate: ranked last, and a session with only that is hidden', () => {
  const hit = (session: string, text: string) => ({ project: '-p', session, file: `/${session}`, text })
  const hits = [
    ...['s1', 's2', 's3', 's4'].map(s => hit(s, 'CLAUDE.md says plan')),
    hit('s1', 'my real plan'),
    hit('s2', 'another plan'),
  ]
  const { found, hidden } = group(hits, '')
  expect(found.map(f => f.id)).toEqual(['s1', 's2'])
  expect(found[0]!.texts).toEqual(['my real plan', 'CLAUDE.md says plan'])
  expect(hidden).toBe(2)
  // when nothing else exists, boilerplate is all there is to show
  expect(group(hits.slice(0, 4), '').found).toHaveLength(4)
  // a line shared by only a few of many sessions stays
  const few = [hit('a', 'same'), hit('b', 'same'), hit('c', 'same'), ...['d', 'e', 'f', 'g', 'h', 'i'].map(s => hit(s, `own ${s}`))]
  expect(group(few, '').hidden).toBe(0)
})

test('a moment is printed as a local date and time', () => {
  expect(when(0)).toBe('—')
  expect(when(Number.NaN)).toBe('—')
  expect(when(Date.parse('2026-11-11T12:00:00Z'))).toMatch(/^2026-11-1[01] \d\d:\d\d$/)
})

async function ask($: Parameters<Parameters<typeof test>[1]>[0], text: string) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'q', text, kind: 'submit' })
  return ui
}

test('a search runs the engine\'s ripgrep over this project and lists the newest session first, without the open one', async ($, on) => {
  const box = fresh()
  box.stdout =
    line(`${DIR}/old.jsonl`, 'the old plan for the pane') +
    line(`${DIR}/new.jsonl`, 'the new plan, token=abcd1234efgh') +
    line(`${DIR}/sess-now.jsonl`, 'the plan I am typing')
  box.mtimes = { [`${DIR}/old.jsonl`]: Date.parse('2026-11-01T10:00:00Z'), [`${DIR}/new.jsonl`]: Date.parse('2026-11-10T10:00:00Z') }
  world(on, box)
  const ui = await ask($, 'plan')
  const run = box.runs[0]!
  expect(run.argv[0]).toBe('/bin/claude')
  expect(run.env).toEqual({ ARGV0: 'rg' })
  expect(run.argv).toContain(patternOf('plan'))
  expect(run.argv.at(-1)).toBe(DIR)
  expect(run.argv.at(-2)).toBe('--')
  expect(await ui.find({ type: 'Text', text: /2 sessions/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude --resume new/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude --resume sess-now/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /abcd1234efgh/ })).toBeUndefined()
  await ui.unmount()
})

test('all projects searches the root, and the button flips the scope and searches again', async ($, on) => {
  const box = fresh()
  box.stdout = line(`${ROOT}/-other/zzz.jsonl`, 'a plan elsewhere')
  world(on, box)
  const ui = await ask($, 'plan')
  expect(box.runs[0]!.argv.at(-1)).toBe(DIR)
  await ui.press({ key: 'scope' })
  expect(box.runs.at(-1)!.argv.at(-1)).toBe(ROOT)
  expect(await ui.find({ type: 'Text', text: /claude --resume zzz/ })).toBeDefined()
  await ui.unmount()
})

test('no match, a too short text and a missing history each say so and run nothing they should not', async ($, on) => {
  const box = fresh()
  box.exitCode = 1
  world(on, box)
  let ui = await ask($, 'ab')
  expect(box.runs).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /at least 3/ })).toBeDefined()
  await ui.input({ key: 'q', text: 'nothing here', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /No session mentions/ })).toBeDefined()
  box.here = false
  await ui.input({ key: 'q', text: 'nothing here', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /No history for this folder/ })).toBeDefined()
  expect(box.runs).toHaveLength(1)
  await ui.unmount()
})

test('without a usable ripgrep the pane says so instead of showing an empty list', async ($, on) => {
  const box = fresh()
  box.broken = true
  world(on, box)
  const ui = await ask($, 'plan')
  expect(box.runs.length).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: /ripgrep not found/ })).toBeDefined()
  await ui.unmount()
})

test('cut output is said, and the command opens the pane and searches what follows it', async ($, on) => {
  const box = fresh()
  box.truncated = true
  box.stdout = line(`${DIR}/aaa.jsonl`, 'cut plan')
  world(on, box)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'recall', args: 'plan' })
  expect(r.text).toContain('opened')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Output was cut/ })).toBeDefined()
  await ui.unmount()
})
