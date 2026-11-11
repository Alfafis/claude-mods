// Draws one frame of a crab: the art's pixels moved by the pose its routine holds at that instant.
// crab-band draws it as nested SVG groups, and the same order holds here: the body and its props
// bob together (`b`), the claws add their own offset on top, the legs lift one pair at a time
// (`la`, `lb`), the whole crab then shifts, turns and mirrors about the routine's pivot (`jx`,
// `jy`, `rot`, `mirror`), and the still props (`nt`, `nt2`) stay out of all of it.

import { ART } from './crab-art'
import { DANCE_SECONDS, MOVES } from './crab-moves'
import type { Pose } from './crab-moves'

export const GRID_W = 30
export const GRID_H = 28

export type Grid = { w: number; h: number; px: (number | undefined)[] }

export const COSTUME_ACCENT: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  doll: '#E0218A',
  medium: '#378ADD',
  light: '#1D9E75',
  haiku: '#3E9B5F',
  sonnet: '#C2569B',
  explore: '#888780',
  other: '#888780',
}

const STILL = new Set(['nt', 'nt2'])
const LEGS = new Set(['la', 'lb'])
const CLAWS = ['cl', 'cr']

const rgb = (hex: string) => parseInt(hex.slice(1), 16)

type Px = { x: number; y: number; color: number; group: string }

const cache = new Map<string, Px[]>()

// The outfit's pixels in draw order: the body first, then the props, the claws last.
function pixelsOf(costume: string): Px[] {
  const hit = cache.get(costume)
  if (hit) return hit
  const outfit = ART.outfits[costume] ? costume : 'other'
  const accent = rgb(COSTUME_ACCENT[outfit] ?? '#888780')
  const all: Px[] = []
  ART.base.rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const cell = ART.base.legend[ch]
      if (!cell) return
      if (cell[2]) all.push({ x, y, color: rgb(cell[2]), group: 'bd' })
      all.push({ x, y, color: rgb(cell[0]), group: cell[1] })
    }),
  )
  for (const part of ART.outfits[outfit]?.parts ?? []) {
    part.rows.forEach((row, j) =>
      [...row].forEach((ch, i) => {
        const c = part.legend[ch]
        if (c) all.push({ x: part.x + i, y: part.y + j, color: c === 'accent' ? accent : rgb(c), group: part.group })
      }),
    )
  }
  const rank = (g: string) => (g === 'bd' ? 0 : CLAWS.includes(g) ? 3 : LEGS.has(g) ? 4 : STILL.has(g) ? 5 : 1)
  const sorted = all.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.group) - rank(b.p.group) || a.i - b.i).map(e => e.p)
  cache.set(costume, sorted)
  return sorted
}

export const routineKey = (costume: string) => (MOVES[costume] ? costume : 'other')

// The pose a routine holds at `ms`: the last key at or before the instant of its 4 s loop.
export function poseAt(costume: string, ms: number): Pose {
  const keys = MOVES[routineKey(costume)]!.keys
  const t = (((ms / 1000) % DANCE_SECONDS) + DANCE_SECONDS) % DANCE_SECONDS
  let pose: Pose = keys[0]?.[1] ?? {}
  for (const [second, p] of keys) {
    if (second <= t) pose = p
    else break
  }
  return pose
}

// Frame of the crab in the window [x0, x0 + w) x [y0, y0 + h) of the 30 x 28 grid.
export function frame(costume: string, pose: Pose, x0: number, y0: number, w: number, h: number): (number | undefined)[] {
  const outfit = routineKey(costume)
  const [ox, oy] = MOVES[outfit]!.origin
  const PAD = 16
  const SW = GRID_W + PAD * 2
  const SH = GRID_H + PAD * 2
  const pre: (number | undefined)[] = new Array(SW * SH).fill(undefined)
  const still: (number | undefined)[] = new Array(SW * SH).fill(undefined)
  const bob = pose.b ?? 0
  for (const p of pixelsOf(costume)) {
    let dx = 0
    let dy = 0
    if (LEGS.has(p.group)) dy = pose[p.group as 'la' | 'lb'] ?? 0
    else if (CLAWS.includes(p.group)) {
      const [cx, cy] = pose[p.group as 'cl' | 'cr'] ?? [0, 0]
      dx = cx
      dy = cy + bob
    } else if (!STILL.has(p.group)) dy = bob
    const x = p.x + dx + PAD
    const y = p.y + dy + PAD
    if (x < 0 || y < 0 || x >= SW || y >= SH) continue
    ;(STILL.has(p.group) ? still : pre)[y * SW + x] = p.color
  }
  const out: (number | undefined)[] = new Array(w * h).fill(undefined)
  const rad = (-(pose.rot ?? 0) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const jx = pose.jx ?? 0
  const jy = pose.jy ?? 0
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const cx = x0 + i + 0.5
      const cy = y0 + j + 0.5
      // undo the shift, the turn and the mirror, in that order, about the pivot
      let vx = cx - ox - jx
      let vy = cy - oy - jy
      const rx = vx * cos - vy * sin
      const ry = vx * sin + vy * cos
      vx = pose.mirror ? -rx : rx
      vy = ry
      const sx = Math.floor(vx + ox) + PAD
      const sy = Math.floor(vy + oy) + PAD
      let c = sx >= 0 && sy >= 0 && sx < SW && sy < SH ? pre[sy * SW + sx] : undefined
      const gx = Math.floor(cx) + PAD
      const gy = Math.floor(cy) + PAD
      const s = gx >= 0 && gy >= 0 && gx < SW && gy < SH ? still[gy * SW + gx] : undefined
      if (s !== undefined) c = s
      out[j * w + i] = c
    }
  }
  return out
}

// The art is drawn on a doubled grid (every pixel is 2 x 2). A pixel of the picture is the colour
// most of the block it covers agrees on; `k` is how many grid pixels one of them covers, and may
// be fractional (2.5 makes the crab a little smaller). A third of a block is enough to draw it,
// so a thin prop survives.
export function shrink(src: (number | undefined)[], w: number, h: number, k: number): Grid {
  const outW = Math.floor(w / k)
  const outH = Math.floor(h / k / 2) * 2
  const px: (number | undefined)[] = new Array(outW * outH).fill(undefined)
  for (let j = 0; j < outH; j++) {
    for (let i = 0; i < outW; i++) {
      const x0 = Math.floor(i * k)
      const x1 = Math.min(w, Math.ceil((i + 1) * k))
      const y0 = Math.floor(j * k)
      const y1 = Math.min(h, Math.ceil((j + 1) * k))
      const seen = new Map<number, number>()
      let cells = 0
      let total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          cells++
          const c = src[y * w + x]
          if (c !== undefined) {
            seen.set(c, (seen.get(c) ?? 0) + 1)
            total++
          }
        }
      }
      let best: number | undefined
      let top = 0
      for (const [c, n] of seen) {
        if (n > top) {
          top = n
          best = c
        }
      }
      if (cells > 0 && total >= cells / 3) px[j * outW + i] = best
    }
  }
  return { w: outW, h: outH, px }
}
