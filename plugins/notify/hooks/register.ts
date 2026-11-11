import type { EngineInterface, Register } from 'claude-code'

import { AWAY_MS, approvalAlert, throttled, turnAlert } from '../lib/alert'
import type { Kind } from '../lib/alert'

const TITLE = 'Claude Code'

const cfg = { minSeconds: 30, onApproval: true, sound: true, toast: true, native: true }

const last: Partial<Record<Kind, number>> = {}

async function alert($: EngineInterface, kind: Kind, text: string): Promise<void> {
  const now = await $.clock.now()
  if (throttled(last[kind], now)) return
  last[kind] = now
  const jobs: Promise<unknown>[] = []
  if (cfg.toast) jobs.push(Promise.resolve($.ui.toast(text)))
  if (cfg.sound) jobs.push($.audio.play({ asset: `sounds/${kind}.wav` }))
  if (cfg.native) jobs.push($.ui.notify(text, { title: TITLE, key: kind, delayMs: AWAY_MS, untilBack: true }))
  await Promise.allSettled(jobs)
}

export const register: Register = (on, options) => {
  cfg.minSeconds = Math.min(3600, Math.max(0, Number(options.minSeconds ?? 30))) || 0
  cfg.onApproval = options.onApproval !== false
  cfg.sound = options.sound !== false
  cfg.toast = options.toast !== false
  cfg.native = options.native !== false

  // Observers only: they hear the end of a turn or a verdict after the rest ran, and never change either.
  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    try {
      const text = turnAlert(e, cfg.minSeconds)
      if (text) await alert($, 'done', text)
    } catch {
      // an alert that fails is never the turn's problem
    }
    return res
  })

  on('tool.check', async ($, e, next) => {
    const res = await next(e)
    try {
      const text = cfg.onApproval ? approvalAlert(e, res.decision) : undefined
      if (text) await alert($, 'ask', text)
    } catch {
      // an alert that fails is never the verdict's problem
    }
    return res
  })
}
