export type Limit = { kind: string; pct: number; resetsAt?: string }

// What the engine last reported about the session.
export type Reading = {
  // share of the window the last response was answered over; absent before the first one
  pct?: number
  tokens?: number
  // the window the share is of: the compaction window when that is smaller than the model's
  window: number
  // the model's own window, only when it is larger than `window`
  modelWindow?: number
  // what the session has cost, as /cost totals it
  usd?: number
  limits: Limit[]
}

// One turn of the main conversation: the context it left, and what it cost.
export type Turn = { pct: number; usd: number }

export type Cat = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }

// The window by category, as /context breaks it down.
export type Crumbs = {
  cats: Cat[]
  total: number
  max: number
  model: string
  files: { path: string; type: string; tokens: number }[]
  // tokens each category gained over the last turn
  delta: Record<string, number>
  // the window shrank over the last turn: the conversation was compacted
  compacted?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    meter: {
      reading: Shaped<Reading | null>
      turns: Shaped<Turn[]>
      mark: Shaped<number | null>
      crumbs: Shaped<Crumbs | null>
      snap: Shaped<Record<string, number>>
      warned: Shaped<boolean>
    }
  }
}
