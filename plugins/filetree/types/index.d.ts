export type Entry = { name: string; kind: 'file' | 'dir' | 'other' | 'more' }
export type Touch = { kind: 'read' | 'write'; at: number }
export type GitInfo = {
  branch: string
  oid: string
  initial: boolean
  detached: boolean
  upstream: boolean
  ahead: number
  behind: number
  stash: number
  op: string
  // path -> two-letter status code, X (index) then Y (working tree)
  files: Record<string, string>
  // absolute paths git ignores (an ignored folder stands for what is under it)
  ignored: Record<string, boolean>
}

export type PrFacts = {
  number: number
  state: 'open' | 'draft' | 'merged' | 'closed'
  checks: 'pass' | 'fail' | 'pending' | 'none'
  review: 'approved' | 'changes' | 'required' | 'none'
}
export type PrInfo = Partial<PrFacts> & {
  key: string
  branch: string
  at: number
  status: 'ok' | 'none' | 'error'
}

export type Preview = {
  path: string
  name: string
  // git status code of the file when it was opened ('' when unchanged)
  code: string
  kind: 'diff' | 'content' | 'hidden' | 'binary' | 'large' | 'error'
  note: string
  lines: string[]
  more: number
  added: number
  removed: number
}

declare module 'claude-code' {
  interface PluginState {
    filetree: {
      root: Shaped<string>
      open: Shaped<Record<string, boolean>>
      children: Shaped<Record<string, Entry[]>>
      touched: Shaped<Record<string, Touch>>
      git: Shaped<GitInfo | null>
      pull: Shaped<PrInfo | null>
      guard: Shaped<Record<string, boolean>>
      peek: Shaped<Preview | null>
      peekTop: Shaped<number>
      query: Shaped<string>
      hits: Shaped<string[] | null>
    }
  }
}
