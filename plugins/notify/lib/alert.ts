export type Kind = 'done' | 'ask'

// The same kind twice inside this gap is one alert: a burst of approvals is one nudge, not five.
export const THROTTLE_MS = 4000

// How long the native notification waits for you to come back on a surface that can hold it.
export const AWAY_MS = 10_000

export const throttled = (last: number | undefined, now: number, gap = THROTTLE_MS): boolean => last !== undefined && now - last < gap

export function fmtDuration(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
}

type Ended = { reason: string; durationMs: number; agentId?: string }

// What to say when a turn ends, or nothing: only the main conversation, never an interrupted turn,
// and only past `minSeconds`.
export function turnAlert(e: Ended, minSeconds: number): string | undefined {
  if (e.agentId !== undefined || e.reason === 'aborted') return undefined
  if (!(e.durationMs >= minSeconds * 1000)) return undefined
  if (e.reason === 'answer') return `Claude finished (${fmtDuration(e.durationMs)})`
  if (e.reason === 'error') return 'Claude stopped on an error'
  return 'Claude refused the request'
}

type Check = { tool: string; tool_use_id?: string; approver?: string }

// A real call put to a person. A `$.tool.check` query has no call id, and a host that answers asks
// itself has nobody to nudge.
export function approvalAlert(e: Check, decision: string): string | undefined {
  if (decision !== 'ask' || e.tool_use_id === undefined || e.approver !== 'person') return undefined
  return `Claude is waiting for your approval (${e.tool.length > 40 ? `${e.tool.slice(0, 39)}…` : e.tool})`
}
