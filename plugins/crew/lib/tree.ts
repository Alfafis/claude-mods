// The roster as the pane lists it: a card under the agent that spawned it. Roots go newest first;
// the cards under one agent go oldest first, so its work reads in the order it happened.

import type { Card } from '../types'

export type Row = { card: Card; depth: number }

const MAX_DEPTH = 4

// A block is a root and everything under it. A block with any agent still running goes in
// `running`, so a parent that finished stays in view while its children work. A card whose
// parent is not in the roster is a root, and so is any card a cycle would otherwise hide.
export function layout(all: Record<string, Card>, group = true): { running: Row[]; finished: Row[] } {
  const cards = Object.values(all)
  const kids = new Map<string, Card[]>()
  const roots: Card[] = []
  for (const c of cards) {
    const parent = group && c.parentId && c.parentId !== c.id && Object.hasOwn(all, c.parentId) ? c.parentId : undefined
    if (parent === undefined) roots.push(c)
    else {
      const list = kids.get(parent) ?? []
      list.push(c)
      kids.set(parent, list)
    }
  }
  const seen = new Set<string>()
  const walk = (c: Card, depth: number, out: Row[]) => {
    if (seen.has(c.id)) return
    seen.add(c.id)
    out.push({ card: c, depth: Math.min(depth, MAX_DEPTH) })
    for (const k of (kids.get(c.id) ?? []).sort((a, b) => a.startedAt - b.startedAt)) walk(k, depth + 1, out)
  }
  const blocks: Row[][] = []
  for (const r of roots.sort((a, b) => b.startedAt - a.startedAt)) {
    const rows: Row[] = []
    walk(r, 0, rows)
    blocks.push(rows)
  }
  for (const c of cards) {
    if (seen.has(c.id)) continue
    const rows: Row[] = []
    walk(c, 0, rows)
    blocks.push(rows)
  }
  return {
    running: blocks.filter(b => b.some(r => r.card.status === 'running')).flat(),
    finished: blocks.filter(b => !b.some(r => r.card.status === 'running')).flat(),
  }
}
