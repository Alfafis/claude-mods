export type Status = 'running' | 'done' | 'failed' | 'killed'

export type Card = {
  id: string
  title: string
  type: string
  model: string
  effort: string
  status: Status
  steps: number
  // size of the last prompt (uncached + cache read + cache write), for the ctx figure
  ctx: number
  // output tokens, summed over the steps
  out: number
  // input tokens summed over the steps: uncached, read from the cache, written to it
  inTok: number
  cacheR: number
  cacheW: number
  // what its steps cost so far, each at the price of the model that ran it; absent until a step
  // had a price. `unpriced`: some step had tokens and no price, so the figure is a floor
  costUsd?: number
  unpriced?: boolean
  // the agent that spawned this one, when the roster has it
  parentId?: string
  // the last tool the agent called, short, while it works
  doing: string
  // the first line of its final answer, once it is over
  result: string
  startedAt: number
  // the last time anything was heard of it: a spawn, a step or a tool call
  lastAt: number
  endedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    crew: {
      roster: Shaped<Record<string, Card>>
      tick: Shaped<number>
      loopId: Shaped<number>
      // what the session's subagents have cost, kept apart from the cards: a card that goes
      // (maxCards, clear) takes nothing from it
      spent: Shaped<{ sum: number; partial: boolean; any: boolean }>
    }
  }
}
