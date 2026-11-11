import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { MAX_QUERY, MIN_QUERY, encodeCwd, group, parseHits, patternOf, shortProject, when } from '../lib/search'
import type { Row, Scope } from '../types'

const PANE = 'recall'
const SHOWN = 15
const TIMEOUT_MS = 30_000

const query = atom({ plugin: 'recall', key: 'query' } as const, '', { shape: 'query-1' })
const scope = atom({ plugin: 'recall', key: 'scope' } as const, 'project' as Scope, { shape: 'scope-1' })
const rows = atom({ plugin: 'recall', key: 'rows' } as const, [] as Row[], { shape: 'rows-1' })
const note = atom({ plugin: 'recall', key: 'note' } as const, '', { shape: 'note-1' })
const busy = atom({ plugin: 'recall', key: 'busy' } as const, false, { shape: 'busy-1' })

const cfg = { scope: 'project' as Scope }

// The folder Claude was opened in, and the search that is current: an older one that finishes late
// must not draw over a newer one.
let cwd = ''
let generation = 0

// Claude Code's own ripgrep is the fast road (the binary answers as `rg` when named so, the way its
// shell does): the system grep takes over a minute across a long history. A `rg` on the PATH is the
// fallback.
async function ripgrep($: EngineInterface, args: string[]) {
  const exe = await $.env.get('CLAUDE_CODE_EXECPATH')
  const tries = [...(exe ? [{ argv: [exe, ...args], env: { ARGV0: 'rg' } }] : []), { argv: ['rg', ...args], env: {} }]
  for (const t of tries) {
    try {
      const r = await $.process.run(t.argv, { env: t.env, timeoutMs: TIMEOUT_MS })
      // 0: matches, 1: none, anything else: not ripgrep, or it failed
      if (r.exitCode === 0 || r.exitCode === 1 || (r.exitCode === 2 && r.stdout.length > 0)) return r
    } catch {
      // try the next
    }
  }
  return undefined
}

async function search($: EngineInterface, text: string): Promise<void> {
  const q = text.trim()
  const mine = ++generation
  await update($, query, () => text)
  const finish = async (msg: string, found: Row[] = []) => {
    if (mine !== generation) return
    await update($, rows, () => found)
    await update($, note, () => msg)
    await update($, busy, () => false)
  }
  if (q.length < MIN_QUERY) return finish(`Type at least ${MIN_QUERY} characters.`)
  if (q.length > MAX_QUERY) return finish(`At most ${MAX_QUERY} characters.`)
  if (/[\r\n]/.test(q)) return finish('One line only.')

  await update($, busy, () => true)
  await update($, note, () => '')
  try {
    const where = await read($, scope)
    const base = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
    const root = `${base.replace(/\/+$/, '')}/projects`
    const dir = where === 'project' && cwd ? `${root}/${encodeCwd(cwd)}` : root
    if (!(await $.fs.exists(dir).catch(() => false))) return finish(where === 'project' ? 'No history for this folder yet. Try “all”.' : 'No history folder found.')

    const r = await ripgrep($, ['-i', '-o', '-H', '--no-heading', '--no-messages', '-m', '12', '-g', '*.jsonl', '-e', patternOf(q), '--', dir])
    if (!r) return finish('ripgrep not found: neither Claude Code’s own nor `rg` on the PATH.')

    const sid = await $.session.id().catch(() => '')
    const { found, hidden } = group(parseHits(r.stdout, root), sid)
    const dated = await Promise.all(
      found.slice(0, 60).map(async f => ({ f, at: (await $.fs.stat(f.file).catch(() => undefined))?.mtimeMs ?? 0 })),
    )
    dated.sort((a, b) => b.at - a.at)
    const out: Row[] = dated.map(({ f, at }) => ({ id: f.id, project: shortProject(f.project), at, texts: f.texts }))
    const cut = (hidden > 0 ? ` ${hidden} more only repeat text common to many sessions.` : '') + (r.isStdoutTruncated ? ' Output was cut: narrow the search.' : '')
    await finish(out.length === 0 ? `No session mentions “${q}”.${cut}` : `${out.length} session${out.length === 1 ? '' : 's'}.${cut}`, out)
  } catch {
    await finish('The search failed or ran out of time. Narrow it, or search this project only.')
  }
}

async function open($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Recall' })
}

export const register: Register = (on, options) => {
  cfg.scope = options.scope === 'all' ? 'all' : 'project'

  on('session.start', async ($, e, next) => {
    cwd = typeof e.cwd === 'string' ? e.cwd : ''
    await update($, scope, () => cfg.scope)
    await $.command.register({ name: 'recall', description: 'Search past sessions: /recall <words> opens the pane, /recall close hides it' })
    return next(e)
  })

  on('command.run', { command: 'recall' }, async ($, e) => {
    const text = e.args.trim()
    if (text === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Recall pane closed.' }
    }
    await open($)
    if (text.length > 0) {
      await update($, query, () => text)
      void search($, text)
    }
    return { text: 'Recall pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const q = await read($, query)
    const where = await read($, scope)
    const found = await read($, rows)
    const msg = await read($, note)
    const working = await read($, busy)
    return (
      <Box flexDirection="column" gap={1}>
        <Input key="q" label="⌕ " placeholder="Search past sessions" value={q} onInput={v => void update($, query, () => v)} onSubmit={v => void search($, v)} />
        <Button
          key="scope"
          plain
          label={where === 'project' ? '● this project   ○ all projects' : '○ this project   ● all projects'}
          onPress={async () => {
            await update($, scope, () => (where === 'project' ? 'all' : 'project'))
            if (q.trim().length > 0) void search($, q)
          }}
        />
        {working ? <Text dimColor>searching…</Text> : msg ? <Text dimColor>{msg}</Text> : <Text dimColor>Enter searches. Text is local; credentials are hidden.</Text>}
        {found.slice(0, SHOWN).map(r => (
          <Box key={`s:${r.id}`} flexDirection="column">
            <Text bold wrap="truncate-end">
              {when(r.at)} <Text dimColor>· {r.project}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">claude --resume {r.id}</Text>
            {r.texts.map((t, i) => (
              <Text key={`s:${r.id}:${i}`} dimColor wrap="truncate-end">  {t}</Text>
            ))}
          </Box>
        ))}
        {found.length > SHOWN ? <Text dimColor>{found.length - SHOWN} older sessions not shown: narrow the search.</Text> : undefined}
      </Box>
    )
  })
}
