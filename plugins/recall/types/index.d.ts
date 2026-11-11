// One session that holds the search text: where it lives, when it last moved, a few trimmed lines.
export type Row = { id: string; project: string; at: number; texts: string[] }

export type Scope = 'project' | 'all'

declare module 'claude-code' {
  interface PluginState {
    recall: {
      query: Shaped<string>
      scope: Shaped<Scope>
      rows: Shaped<Row[]>
      note: Shaped<string>
      busy: Shaped<boolean>
    }
  }
}
