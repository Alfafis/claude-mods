import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { approvalAlert, fmtDuration, throttled, turnAlert } from '../lib/alert'

type Box = { toasts: string[]; sounds: string[]; notes: { text: string; title?: string; key?: string; delayMs?: number; untilBack?: boolean }[]; brokenSound: boolean }

const fresh = (): Box => ({ toasts: [], sounds: [], notes: [], brokenSound: false })

function world(on: On, box: Box) {
  mock.clock(on, { now: Date.parse('2026-11-11T12:00:00Z') })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', (_$, e) => {
    box.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    if (box.brokenSound) throw new Error('no player')
    box.sounds.push((e.clip as { asset: string }).asset)
    return { value: undefined }
  })
  on('ui.notify', (_$, e) => {
    box.notes.push({ text: e.text, title: e.title, key: e.key, delayMs: e.delayMs, untilBack: e.untilBack })
    return { value: { isSent: true } } as never
  })
}

const end = (over: Record<string, unknown> = {}) => ({ turnId: 't1', answer: '', durationMs: 45_000, isAborted: false, reason: 'answer' as const, ...over })

test('durations read as seconds, minutes, and minutes with seconds', () => {
  expect(fmtDuration(45_000)).toBe('45s')
  expect(fmtDuration(120_000)).toBe('2m')
  expect(fmtDuration(125_000)).toBe('2m 5s')
  expect(fmtDuration(Number.NaN)).toBe('0s')
})

test('a turn alerts only on the main loop, past the minimum, and never when it was interrupted', () => {
  expect(turnAlert({ reason: 'answer', durationMs: 45_000 }, 30)).toBe('Claude finished (45s)')
  expect(turnAlert({ reason: 'answer', durationMs: 29_999 }, 30)).toBeUndefined()
  expect(turnAlert({ reason: 'answer', durationMs: 0 }, 0)).toBe('Claude finished (0s)')
  expect(turnAlert({ reason: 'aborted', durationMs: 90_000 }, 30)).toBeUndefined()
  expect(turnAlert({ reason: 'answer', durationMs: 90_000, agentId: 'a1' }, 30)).toBeUndefined()
  expect(turnAlert({ reason: 'error', durationMs: 90_000 }, 30)).toBe('Claude stopped on an error')
  expect(turnAlert({ reason: 'refusal', durationMs: 90_000 }, 30)).toBe('Claude refused the request')
  expect(turnAlert({ reason: 'answer', durationMs: Number.NaN }, 30)).toBeUndefined()
})

test('an approval alerts only for a real call put to a person, and a long tool name is cut', () => {
  expect(approvalAlert({ tool: 'Bash', tool_use_id: 'u1', approver: 'person' }, 'ask')).toBe('Claude is waiting for your approval (Bash)')
  expect(approvalAlert({ tool: 'Bash', tool_use_id: 'u1', approver: 'person' }, 'allow')).toBeUndefined()
  expect(approvalAlert({ tool: 'Bash', approver: 'person' }, 'ask')).toBeUndefined()
  expect(approvalAlert({ tool: 'Bash', tool_use_id: 'u1', approver: 'host' }, 'ask')).toBeUndefined()
  expect(approvalAlert({ tool: 'Bash', tool_use_id: 'u1' }, 'ask')).toBeUndefined()
  expect(approvalAlert({ tool: `mcp__${'x'.repeat(60)}`, tool_use_id: 'u1', approver: 'person' }, 'ask')).toContain('…)')
})

test('the same kind inside the gap is throttled, another kind or a later one is not', () => {
  expect(throttled(undefined, 1000)).toBe(false)
  expect(throttled(1000, 2000)).toBe(true)
  expect(throttled(1000, 5000)).toBe(false)
})

test('a long turn raises a toast, a sound and a native notification held for the person to come back', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const res = await $.turn.complete(end())
  expect(res.text).toBe('')
  expect(box.toasts).toEqual(['Claude finished (45s)'])
  expect(box.sounds).toEqual(['sounds/done.wav'])
  expect(box.notes).toHaveLength(1)
  expect(box.notes[0]).toMatchObject({ text: 'Claude finished (45s)', title: 'Claude Code', key: 'done', delayMs: 10_000, untilBack: true })
})

test('a short turn and an interrupted one say nothing', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(end({ durationMs: 5000 }))
  await $.turn.complete(end({ reason: 'aborted', isAborted: true }))
  expect(box.toasts).toEqual([])
  expect(box.sounds).toEqual([])
  expect(box.notes).toEqual([])
})

test('two turns inside the gap alert once', async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete(end())
  await $.turn.complete(end({ turnId: 't2' }))
  expect(box.toasts).toHaveLength(1)
})

test('each channel can be turned off', { options: { sound: false, toast: false, native: false } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete(end())
  expect(box.toasts).toEqual([])
  expect(box.sounds).toEqual([])
  expect(box.notes).toEqual([])
})

test('minSeconds 0 alerts on every turn', { options: { minSeconds: 0 } }, async ($, on) => {
  const box = fresh()
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.turn.complete(end({ durationMs: 800 }))
  expect(box.toasts).toEqual(['Claude finished (1s)'])
})

test('a sound that cannot play never reaches the turn, and the toast still shows', async ($, on) => {
  const box = fresh()
  box.brokenSound = true
  world(on, box)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const res = await $.turn.complete(end())
  expect(res.text).toBe('')
  expect(box.toasts).toEqual(['Claude finished (45s)'])
})

test('a tool.check query that comes out as ask alerts nobody and keeps its verdict', async ($, on) => {
  const box = fresh()
  world(on, box)
  on('tool.check', () => ({ decision: 'ask', reason: 'test' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const res = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(res.decision).toBe('ask')
  expect(box.toasts).toEqual([])
  expect(box.sounds).toEqual([])
})
