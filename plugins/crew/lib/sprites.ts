// Mascots for the Raster: the crab frame from dance.ts packed as half blocks, two pixels per
// terminal cell, the upper one as the foreground of "▀" and the lower one as its background.

import { frame, poseAt, shrink } from './dance'
import type { Grid } from './dance'

export type Mood = 'run' | 'done' | 'failed' | 'killed'

// The part of the 30 x 28 grid that is drawn: the crab, its props and room for the dance.
const X0 = -2
const Y0 = 0
const W = 36
const H = 30
// how many grid pixels one pixel of the picture covers
const K = 2.5

export const COLUMNS = Math.floor(W / K)
export const ROWS = Math.floor(H / K / 2)

const DEFAULT = 0x01000000

const COSTUMES = ['doll', 'haiku', 'sonnet', 'careful', 'other']

function hashed(type: string): string {
  let h = 0
  for (const c of type) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COSTUMES[h % COSTUMES.length] as string
}

// Which outfit an agent type wears. The types the engine ships are fixed; anything else takes one
// from its name, so a custom agent keeps its look.
export function costumeFor(type: string): string {
  const t = type.toLowerCase()
  if (/explore|investigat|search/.test(t)) return 'explore'
  if (/opus/.test(t)) return 'fable'
  if (/plan|architect/.test(t)) return 'heavy'
  if (/build|implement|routine/.test(t)) return 'medium'
  if (/review|audit|critic/.test(t)) return 'light'
  if (/general/.test(t)) return 'other'
  return hashed(t)
}

const mix = (c: number, to: number, by: number) => {
  const ch = (shift: number) => Math.round(((c >> shift) & 0xff) * (1 - by) + ((to >> shift) & 0xff) * by)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

function tint(c: number, mood: Mood): number {
  if (mood === 'failed') return mix(c, 0xe5484d, 0.55)
  if (mood === 'killed') {
    const g = Math.round((((c >> 16) & 0xff) * 0.3 + ((c >> 8) & 0xff) * 0.59 + (c & 0xff) * 0.11) * 0.55)
    return (g << 16) | (g << 8) | g
  }
  return c
}

export type Sprite = { columns: number; rows: number; cells: string }

export function pack(grid: Grid): Sprite {
  const rows = Math.floor(grid.h / 2)
  // little-endian whatever the host is: that is the Raster's contract
  const bytes = new Uint8Array(grid.w * rows * 3 * 4)
  const view = new DataView(bytes.buffer)
  let at = 0
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < grid.w; x++) {
      const top = grid.px[r * 2 * grid.w + x]
      const bottom = grid.px[(r * 2 + 1) * grid.w + x]
      const [code, fg, bg] =
        top === undefined && bottom === undefined
          ? [0x20, DEFAULT, DEFAULT]
          : top === undefined
            ? [0x2584, bottom!, DEFAULT]
            : bottom === undefined
              ? [0x2580, top, DEFAULT]
              : [0x2580, top, bottom]
      for (const word of [code!, fg!, bg!]) {
        view.setUint32(at, word, true)
        at += 4
      }
    }
  }
  return { columns: grid.w, rows, cells: (bytes as unknown as { toBase64(): string }).toBase64() }
}

// One frame of an agent's crab. While it runs the crab dances its outfit's routine, `ms` into it;
// once over it stands still, tinted by how it ended.
export function sprite(type: string, mood: Mood, ms: number): Sprite {
  const costume = costumeFor(type)
  const pose = mood === 'run' ? poseAt(costume, ms) : {}
  const grid = shrink(frame(costume, pose, X0, Y0, W, H), W, H, K)
  if (mood !== 'run') grid.px = grid.px.map(c => (c === undefined ? undefined : tint(c, mood)))
  return pack(grid)
}
