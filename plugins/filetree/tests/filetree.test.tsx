import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { badges, describe, fileIcon, githubRepo, gitTone, isSensitive, parseStatus, summarizePr, tally } from '../hooks/register'

const ROOT = '/home/k/proj'
const PANE = {
  plugin: 'filetree',
  component: 'Pane',
  requestId: 'filetree',
  props: {
    title: 'Files',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DIRS: Record<string, [string, 'file' | 'dir'][]> = {
  [ROOT]: [
    ['src', 'dir'],
    ['README.md', 'file'],
    ['node_modules', 'dir'],
    ['.git', 'dir'],
    ['.env', 'file'],
    ['.env.example', 'file'],
    ['logo.bin', 'file'],
  ],
  [`${ROOT}/src`]: [['a.ts', 'file']],
  '/home/k/other': [['x.ts', 'file']],
}

// Nothing sits beneath the plugin: each hook here stands for the engine.
type Opts = { statThrows?: boolean; notGit?: boolean; toasts?: string[]; op?: string; stash?: number; root?: { dir: string }; gh?: string; remote?: string; diff?: string; diffFail?: boolean; files?: Record<string, string>; reads?: string[]; list?: string }

const opens: string[] = []

function world(on: On, status: string, ran: string[][] = [], opts: Opts = {}) {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.CwdChanged', () => ({}))
  on('session.root', () => ({ value: opts.root?.dir ?? ROOT }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_$, e) => {
    opts.toasts?.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  on('fs.stat', (_$, e) => {
    if (opts.statThrows) throw new Error('boom')
    // git's own directory holds the in-progress markers: absent unless a test sets one
    if (e.path.includes('/.git/') && !(opts.op && e.path.endsWith(`/${opts.op}`))) throw new Error('ENOENT')
    const isDir = e.path in DIRS
    return { value: { kind: isDir ? 'dir' : 'file', size: opts.files?.[e.path]?.length ?? 10, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('fs.read', (_$, e) => {
    opts.reads?.push(e.path)
    const text = opts.files?.[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', (_$, e) => ({
    value: (DIRS[e.path] ?? []).map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    if (opts.notGit) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv.includes('rev-parse')) return { value: { exitCode: 0, stdout: `${ROOT}\n${ROOT}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv.includes('ls-files')) return { value: { exitCode: 0, stdout: opts.list ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv.includes('diff')) {
      const base = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      return { value: opts.diffFail ? { ...base, exitCode: 128, stdout: '' } : { ...base, exitCode: 0, stdout: opts.diff ?? '' } }
    }
    if (argv.includes('remote')) return { value: { exitCode: 0, stdout: opts.remote ?? 'git@github.com:Alfafis/claude-mods.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'gh') {
      if (opts.gh === undefined) return { value: { exitCode: 1, stdout: '', stderr: 'gh: not logged in', isStdoutTruncated: false, isStderrTruncated: false } }
      return { value: { exitCode: 0, stdout: opts.gh, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const out = argv.includes('stash') ? 'stash@{0}: a\n'.repeat(opts.stash ?? 0) : status
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return clock
}

const head = (branch: string, extra = '') => `# branch.oid abc1234def\0# branch.head ${branch}\0${extra}`
const STATUS = `${head('main', '# branch.upstream origin/main\0# branch.ab +1 -0\0')}1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0? README.md\0! node_modules/\0! .env\0`

test('parseStatus reads the v2 headers, entries, renames and conflicts', () => {
  const out = parseStatus(
    [
      '# branch.oid abc1234def',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +2 -1',
      '2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.ts',
      'old.ts',
      '1 MM N... 100644 100644 100644 aaaa bbbb b.ts',
      'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc c.ts',
      '? dir/',
      '',
    ].join('\0'),
  )
  expect(out.branch).toBe('feat/x')
  expect(out.upstream).toBe(true)
  expect(out.ahead).toBe(2)
  expect(out.behind).toBe(1)
  expect(out.entries).toEqual([
    ['new name.ts', 'R '],
    ['b.ts', 'MM'],
    ['c.ts', 'UU'],
    ['dir', '??'],
  ])
  const fresh = parseStatus('# branch.oid (initial)\0# branch.head main\0')
  expect(fresh.oid).toBe('(initial)')
  expect(fresh.upstream).toBe(false)
})

test('badges and tally tell staged, changed, untracked and conflicted apart', () => {
  expect(badges('M ')).toEqual([['✚', 'success']])
  expect(badges(' M')).toEqual([['●', 'warning']])
  expect(badges('MM')).toEqual([['✚', 'success'], ['●', 'warning']])
  expect(badges(' D')).toEqual([['−', 'error']])
  expect(badges('??')).toEqual([['?', 'success']])
  for (const xy of ['UU', 'AA', 'DD', 'AU', 'UD']) expect(badges(xy)).toEqual([['✖', 'error']])
  expect(tally({ a: 'M ', b: 'MM', c: ' M', d: '??', e: 'UU' })).toEqual({ staged: 2, changed: 2, untracked: 1, conflicts: 1 })
})

test('the pane draws the root without noise folders, with git codes, on every surface', async ($, on) => {
  const ran: string[][] = []
  world(on, STATUS, ran)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /⎇ main ↑1/ }))?.text).toBe('⎇ main ↑1')
    expect(await ui.find({ type: 'Button', key: `${ROOT}/src` })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /\.git$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: `${ROOT}/node_modules` })).toBeDefined()
    const readme = await ui.find({ type: 'Button', key: `${ROOT}/README.md` })
    expect(readme?.text).toContain('README.md')
    expect(readme?.text).toContain('?')
    await ui.unmount()
  }

  // git runs without optional locks or a repo's fsmonitor
  const status = ran.find(a => a.includes('status'))
  expect(status).toContain('--no-optional-locks')
  expect(status).toContain('core.fsmonitor=false')
})

test('a folder opens on press and its files appear', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: `${ROOT}/src` })
    expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeDefined()
    await ui.press({ key: `${ROOT}/src` })
    expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a Read tints the file and the tool result goes back untouched', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md` })
  expect(ran.deny).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const names = await ui.findAll({ type: 'Text', text: /README\.md/ })
  expect(names.some(n => n.props.color === 'suggestion')).toBe(true)
  await ui.unmount()
})

test('a bookkeeping failure never reaches the tool call', async ($, on) => {
  world(on, STATUS, [], { statThrows: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a.ts`, old_string: 'a', new_string: 'b' })
  expect(ran.deny).toBeUndefined()
  expect(ran.isError).not.toBe(true)
})

test('outside a git repository the pane still lists files and says so', async ($, on) => {
  world(on, STATUS, [], { notGit: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `${ROOT}/src` })).toBeDefined()
  await ui.unmount()
})

test('isSensitive flags secret-looking names and spares templates and public keys', () => {
  for (const hit of ['/a/.env', '/a/.env.local', '/a/.ENV.production', '/a/server.pem', '/a/tls.key', '/a/id_rsa', '/a/id_ed25519', '/h/.aws/credentials', '/a/secrets.yml', '/a/.npmrc', '/a/my-service-account.json'])
    expect(isSensitive(hit)).toBe(true)
  for (const miss of ['/a/.env.example', '/a/.env.sample', '/a/.env.template', '/a/id_rsa.pub', '/a/README.md', '/a/environment.ts', '/a/keyboard.ts', '/a/credentials-helper.ts'])
    expect(isSensitive(miss)).toBe(false)
})

test('reading a secret raises one toast, marks the row, and leaves the call untouched', async ($, on) => {
  const toasts: string[] = []
  world(on, STATUS, [], { toasts })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (let i = 0; i < 2; i++) {
    const ran = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/.env` })
    expect(ran.deny).toBeUndefined()
  }
  expect(toasts).toEqual(['Claude read a sensitive file: .env'])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = (await ui.findAll({ type: 'Text', text: /\.env\b/ })).find(n => n.props.color === 'error')
    expect(row).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /⚠/ })).length).toBeGreaterThan(0)
    await ui.unmount()
  }
})

test('a template and an ordinary file raise no alert', async ($, on) => {
  const toasts: string[] = []
  world(on, STATUS, [], { toasts })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/.env.example` })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/README.md` })
  expect(toasts).toEqual([])
})

test('the header shows counts, stash, an unfinished operation and a missing upstream', async ($, on) => {
  const status = `${head('feat/x')}u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/a.ts\0` + '1 M. N... 100644 100644 100644 aaaa bbbb README.md\0'
  world(on, status, [], { op: 'MERGE_HEAD', stash: 2 })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⎇ feat\/x \(no upstream\)/ })).toBeDefined()
  const line = await ui.find({ type: 'Text', text: /MERGING/ })
  expect(line?.text).toContain('✖1')
  expect(line?.text).toContain('✚1')
  expect(line?.text).toContain('⚑2')
  // the collapsed folder that holds the conflict says so
  const dir = await ui.find({ type: 'Button', key: `${ROOT}/src` })
  expect(dir?.text).toContain('✖')
  await ui.unmount()
})

test('a clean branch with no stash and no operation shows no summary line', async ($, on) => {
  world(on, `${head('main', '# branch.upstream origin/main\0# branch.ab +0 -0\0')}`)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /MERGING|✚|⚑/ })).toBeUndefined()
  await ui.unmount()
})

test('a touched file opens its folders, once, and a folder the user closed stays closed', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a.ts`, old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const name = (await ui.findAll({ type: 'Text', text: /a\.ts/ })).find(n => n.props.color === 'claude')
  expect(name).toBeDefined()
  expect((await ui.find({ type: 'Button', key: `${ROOT}/src` }))?.text).toContain('\ueab4')

  await ui.press({ key: `${ROOT}/src` })
  expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeUndefined()
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a.ts`, old_string: 'b', new_string: 'c' })
  expect(await ui.find({ type: 'Text', text: /a\.ts/ })).toBeUndefined()
  await ui.unmount()
})

test('a file under an ignored folder or outside the root opens nothing', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const a = await $.tool.call({ tool: 'Read', file_path: `${ROOT}/node_modules/x/y.js` })
  const b = await $.tool.call({ tool: 'Read', file_path: '/etc/hosts' })
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: `${ROOT}/src` }))?.text).toContain('\ueab6')
  await ui.unmount()
})

test('the tree follows the session root after it moves', async ($, on) => {
  const root = { dir: ROOT }
  world(on, STATUS, [], { root })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^PROJ$/ })).toBeDefined()

  root.dir = '/home/k/other'
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: root.dir })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /^OTHER$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /x\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: `${ROOT}/src` })).toBeUndefined()
  await ui.unmount()
})

const PR_OPEN = JSON.stringify([
  {
    number: 12,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { state: 'SUCCESS' },
    ],
  },
])

test('githubRepo accepts only github.com remotes and rejects the rest', () => {
  expect(githubRepo('https://github.com/Alfafis/claude-mods.git')).toBe('Alfafis/claude-mods')
  expect(githubRepo('https://github.com/Alfafis/claude-mods')).toBe('Alfafis/claude-mods')
  expect(githubRepo('git@github.com:Alfafis/claude-mods.git')).toBe('Alfafis/claude-mods')
  expect(githubRepo('ssh://git@github.com/a/b.git')).toBe('a/b')
  for (const no of ['https://gitlab.com/a/b.git', 'https://token@github.com/a/b.git', 'https://github.com.evil.io/a/b', 'git@github.com:a/b/c.git', 'https://github.com/a/b;rm', ''])
    expect(githubRepo(no)).toBeUndefined()
})

test('summarizePr reads state, checks and review, and survives odd input', () => {
  expect(summarizePr(JSON.parse(PR_OPEN))).toEqual({ number: 12, state: 'open', checks: 'pass', review: 'approved' })
  const draft = [{ number: 3, state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }]
  expect(summarizePr(draft)).toEqual({ number: 3, state: 'draft', checks: 'pending', review: 'required' })
  const failed = [{ number: 4, state: 'MERGED', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }, { state: 'PENDING' }] }]
  expect(summarizePr(failed)).toEqual({ number: 4, state: 'merged', checks: 'fail', review: 'changes' })
  expect(summarizePr([{ number: 5, state: 'CLOSED', reviewDecision: '' }])).toEqual({ number: 5, state: 'closed', checks: 'none', review: 'none' })
  for (const bad of [[], {}, null, 'x', [{}], [{ number: 'a' }], [null]]) expect(summarizePr(bad)).toBeUndefined()
})

test('GitHub is off by default: gh is never run', async ($, on) => {
  const ran: string[][] = []
  world(on, STATUS, ran, { gh: PR_OPEN })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /PR #/ })).toBeUndefined()
  await ui.unmount()
  expect(ran.some(a => a[0] === 'gh')).toBe(false)
  expect(ran.some(a => a.includes('remote'))).toBe(false)
})

test('GitHub on: the pane shows the pull request, and refresh asks again', { options: { github: true } }, async ($, on) => {
  const ran: string[][] = []
  world(on, STATUS, ran, { gh: PR_OPEN })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const line = await ui.find({ type: 'Text', text: /PR #12/ })
    expect(line?.text).toContain('open')
    expect(line?.text).toContain('CI ✔')
    expect(line?.text).toContain('approved')
    await ui.unmount()
  }
  const calls = () => ran.filter(a => a[0] === 'gh')
  expect(calls().length).toBe(1)
  expect(calls()[0]).toContain('Alfafis/claude-mods')
  expect(calls()[0]).toContain('--head=main')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  expect(calls().length).toBe(2)
  await ui.unmount()
})

test('GitHub on: a pushed branch without a pull request says no PR', { options: { github: true } }, async ($, on) => {
  world(on, STATUS, [], { gh: '[]' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^no PR$/ })).toBeDefined()
  await ui.unmount()
})

test('GitHub on: a gh failure shows a quiet note and never breaks the pane', { options: { github: true } }, async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /PR unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⎇ main/ })).toBeDefined()
  await ui.unmount()
})

test('GitHub on: a non-GitHub remote runs no gh and shows nothing', { options: { github: true } }, async ($, on) => {
  const ran: string[][] = []
  world(on, STATUS, ran, { gh: PR_OPEN, remote: 'https://gitlab.com/a/b.git\n' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /PR #|PR unavailable|^no PR$/ })).toBeUndefined()
  await ui.unmount()
  expect(ran.some(a => a[0] === 'gh')).toBe(false)
})

test('GitHub on: an unpublished branch asks nothing of the network', { options: { github: true } }, async ($, on) => {
  const ran: string[][] = []
  world(on, `${head('feat/x')}`, ran, { gh: PR_OPEN })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /PR #/ })).toBeUndefined()
  await ui.unmount()
  expect(ran.some(a => a[0] === 'gh')).toBe(false)
})

// the pane has settled once a mount returns; the write comes after it
async function settled($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.unmount()
}

test('editing on main warns once about the branch and once about uncommitted changes', async ($, on) => {
  const toasts: string[] = []
  world(on, STATUS, [], { toasts })
  await settled($)
  const edit = (file: string) => $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: 'a', new_string: 'b' })

  const ran = await edit('src/a.ts')
  expect(ran.deny).toBeUndefined()
  expect(toasts).toEqual(['Claude changed a file with uncommitted changes: a.ts', 'Claude changed a file on main: use a feature branch'])

  // same file again, and a clean one: the branch was already flagged
  await edit('src/a.ts')
  await edit('src/other.ts')
  expect(toasts.length).toBe(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const header = await ui.find({ type: 'Text', text: /⎇ main/ })
  expect(header?.text).toContain('⚠ Claude edited here')
  expect(header?.props.color).toBe('error')
  await ui.unmount()
})

test('on a feature branch only a changed file warns, and a read warns about nothing', async ($, on) => {
  const toasts: string[] = []
  const status = `${head('feat/x', '# branch.upstream origin/feat/x\0# branch.ab +0 -0\0')}1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0`
  world(on, status, [], { toasts })
  await settled($)

  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/a.ts` })
  expect(toasts).toEqual([])
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/clean.ts`, old_string: 'a', new_string: 'b' })
  expect(toasts).toEqual([])
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a.ts`, old_string: 'a', new_string: 'b' })
  expect(toasts).toEqual(['Claude changed a file with uncommitted changes: a.ts'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /⎇ feat\/x/ }))?.text).not.toContain('⚠')
  await ui.unmount()
})

test('a clean file on main raises only the branch warning', async ($, on) => {
  const toasts: string[] = []
  world(on, STATUS, [], { toasts })
  await settled($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/new.md`, content: 'x' })
  expect(toasts).toEqual(['Claude changed a file on main: use a feature branch'])
})

test('a detached head is not a protected branch', async ($, on) => {
  const toasts: string[] = []
  world(on, `${head('(detached)')}`, [], { toasts })
  await settled($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/docs/new.md`, content: 'x' })
  expect(toasts).toEqual([])
})

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  '',
].join('\n')

const all = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text?: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(n => n.text ?? '')

test('clicking a changed file shows its diff, coloured, and a second click closes it', async ($, on) => {
  const ran: string[][] = []
  world(on, STATUS, ran, { diff: DIFF })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: `${ROOT}/src` })
    await ui.press({ key: `${ROOT}/src/a.ts` })
    expect((await ui.find({ type: 'Text', text: /modified · \+1 −1/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^\+new$/ }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: /^-old$/ }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: /^@@/ })).toBeDefined()
    expect((await all(ui)).some(t => t.startsWith('diff --git') || t.startsWith('index '))).toBe(false)
    await ui.press({ key: `${ROOT}/src/a.ts` })
    expect(await ui.find({ type: 'Text', text: /^\+new$/ })).toBeUndefined()
    await ui.press({ key: `${ROOT}/src` })
    await ui.unmount()
  }
  const diff = ran.find(a => a.includes('diff'))
  expect(diff).toContain('--no-ext-diff')
  expect(diff).toContain('--no-textconv')
  expect(diff).toContain('HEAD')
})

test('clicking an untracked file shows its content with control characters defused', async ($, on) => {
  const files = { [`${ROOT}/README.md`]: '# hi\nsecond\x1b]0;pwned\x07\r\n\tthird\n' }
  world(on, STATUS, [], { files })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `${ROOT}/README.md` })
  expect(await ui.find({ type: 'Text', text: /untracked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^# hi$/ })).toBeDefined()
  const texts = await all(ui)
  expect(texts.some(t => t.includes('\x1b') || t.includes('\x07') || t.includes('\r'))).toBe(false)
  expect(texts.some(t => t === 'second?]0;pwned?')).toBe(true)
  expect(texts.some(t => t === '  third')).toBe(true)
  await ui.unmount()
})

test('a sensitive file is never read for a preview', async ($, on) => {
  const reads: string[] = []
  const ran: string[][] = []
  world(on, STATUS, ran, { files: { [`${ROOT}/.env`]: 'TOKEN=abc' }, reads })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `${ROOT}/.env` })
  expect(await ui.find({ type: 'Text', text: /sensitive file: preview hidden/ })).toBeDefined()
  expect((await all(ui)).some(t => t.includes('TOKEN'))).toBe(false)
  expect(reads).toEqual([])
  expect(ran.some(a => a.includes('diff'))).toBe(false)
  await ui.unmount()
})

test('a binary file and a failing diff each fall back sensibly', async ($, on) => {
  world(on, STATUS, [], { files: { [`${ROOT}/logo.bin`]: 'ab\0cd', [`${ROOT}/src/a.ts`]: 'const a = 1\n' }, diffFail: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `${ROOT}/logo.bin` })
  expect(await ui.find({ type: 'Text', text: /^binary file$/ })).toBeDefined()
  await ui.press({ key: `${ROOT}/src` })
  await ui.press({ key: `${ROOT}/src/a.ts` })
  expect(await ui.find({ type: 'Text', text: /^const a = 1$/ })).toBeDefined()
  await ui.press({ key: 'peek-close' })
  expect(await ui.find({ type: 'Text', text: /^const a = 1$/ })).toBeUndefined()
  await ui.unmount()
})

test('file names take their colour from the git state', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tone = async (re: RegExp) => (await ui.findAll({ type: 'Text', text: re })).map(n => n.props.color).find(Boolean)
  expect(await tone(/^README\.md$/)).toBe('success')
  await ui.press({ key: `${ROOT}/src` })
  expect(await tone(/^a\.ts$/)).toBe('warning')
  expect(await tone(/^\.env\.example$/)).toBeUndefined()
  await ui.unmount()
})

test('gitTone and describe read the status codes', () => {
  expect(gitTone(' M')).toBe('warning')
  expect(gitTone('M ')).toBe('success')
  expect(gitTone('??')).toBe('success')
  expect(gitTone(' D')).toBe('error')
  expect(gitTone('UU')).toBe('error')
  expect(gitTone(undefined)).toBeUndefined()
  expect(describe('MM')).toBe('staged + modified')
  expect(describe(' D')).toBe('deleted')
  expect(describe('')).toBe('unchanged')
})

test('parseStatus keeps ignored paths apart from changes', () => {
  const out = parseStatus(`${head('main')}! node_modules/\0! dist/app.js\0? new.ts\0`)
  expect(out.ignored).toEqual(['node_modules', 'dist/app.js'])
  expect(out.entries).toEqual([['new.ts', '??']])
})

test('fileIcon colours by name and extension, with a plain fallback', () => {
  expect(fileIcon('a.ts').color).toBe('#519aba')
  expect(fileIcon('.gitignore').color).toBe('#f14e32')
  expect(fileIcon('.env.local').color).toBe('#faf743')
  expect(fileIcon('Makefile')).toEqual({ nerd: '\uf15b', color: '#8a8a8a' })
  expect(fileIcon('A.TS').color).toBe('#519aba')
})

test('the header shows the root in capitals with search, refresh and collapse', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^PROJ$/ })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'search' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'collapse' })).toBeDefined()
    await ui.unmount()
  }
})

test('ignored folders are dimmed, the rest are bold', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'true' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const props = async (re: RegExp) => (await ui.findAll({ type: 'Text', text: re }))[0]?.props
  expect(await props(/^node_modules$/)).toMatchObject({ dimColor: true, bold: false })
  expect(await props(/^src$/)).toMatchObject({ dimColor: false, bold: true })
  await ui.unmount()
})

test('collapse closes every open folder', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `${ROOT}/src` })
  expect(await ui.find({ type: 'Text', text: /^a\.ts$/ })).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ type: 'Text', text: /^a\.ts$/ })).toBeUndefined()
  await ui.unmount()
})

test('searching lists matching files from git, flat, and a click previews one', async ($, on) => {
  const ran: string[][] = []
  world(on, STATUS, ran, { list: 'src/a.ts\0src/deep/alpha.ts\0README.md\0docs/guide.md\0', files: { [`${ROOT}/src/a.ts`]: 'x' } })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'a.ts', kind: 'submit' })
  expect(await ui.find({ type: 'Button', key: 'hit:src/a.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'hit:README.md' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: `${ROOT}/src` })).toBeUndefined()
  const lister = ran.find(a => a.includes('ls-files'))
  expect(lister).toContain('--exclude-standard')
  expect(lister).toContain('core.fsmonitor=false')
  await ui.input({ key: 'search', text: 'zzz', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /No matches/ })).toBeDefined()
  await ui.input({ key: 'search', text: '', kind: 'submit' })
  expect(await ui.find({ type: 'Button', key: `${ROOT}/src` })).toBeDefined()
  await ui.unmount()
})

test('typing searches after a pause, not on every key', async ($, on) => {
  const ran: string[][] = []
  const clock = world(on, STATUS, ran, { list: 'README.md\0' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'search', text: 'R', kind: 'change' })
  await ui.input({ key: 'search', text: 'RE', kind: 'change' })
  expect(ran.filter(a => a.includes('ls-files')).length).toBe(0)
  await clock.advance(300)
  expect(ran.filter(a => a.includes('ls-files')).length).toBe(1)
  expect(await ui.find({ type: 'Button', key: 'hit:README.md' })).toBeDefined()
  await ui.unmount()
})

test('icons dot draws a coloured square and the classic chevrons', { options: { icons: 'dot' } }, async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: `${ROOT}/README.md` }))?.text).toContain('■')
  await ui.unmount()
})

test('icons default to nerd: folder and file glyphs', async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: `${ROOT}/src` }))?.text).toContain('\uf07b')
  expect((await ui.find({ type: 'Button', key: `${ROOT}/README.md` }))?.text).toContain('\ue609')
  await ui.unmount()
})

test('icons none draws names only', { options: { icons: 'none' } }, async ($, on) => {
  world(on, STATUS)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: `${ROOT}/README.md` }))?.text).not.toContain('■')
  await ui.unmount()
})

test('a long preview is paged with buttons, and a new file starts at the top', async ($, on) => {
  const text = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')
  world(on, STATUS, [], { files: { [`${ROOT}/README.md`]: text, [`${ROOT}/.env.example`]: 'x' } })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `${ROOT}/README.md` })
  expect(await ui.find({ type: 'Text', text: /^line1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^line7$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'peek-down' }))?.text).toContain('24 more lines')
  expect(await ui.find({ type: 'Button', key: 'peek-up' })).toBeUndefined()
  await ui.press({ key: 'peek-down' })
  expect(await ui.find({ type: 'Text', text: /^line1$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^line7$/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'peek-up' }))?.text).toContain('6 lines above')
  await ui.press({ key: 'peek-up' })
  expect(await ui.find({ type: 'Text', text: /^line1$/ })).toBeDefined()
  await ui.press({ key: 'peek-down' })
  await ui.press({ key: `${ROOT}/.env.example` })
  expect(await ui.find({ type: 'Button', key: 'peek-up' })).toBeUndefined()
  await ui.unmount()
})

test('the pane opens by itself at session start, and only on the command when autoOpen is off', async ($, on) => {
  opens.length = 0
  world(on, STATUS, [], {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(opens).toEqual(['filetree'])
})

test('autoOpen off keeps the pane shut at session start and /filetree still opens it', { options: { autoOpen: false } }, async ($, on) => {
  opens.length = 0
  world(on, STATUS, [], {})
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect(opens).toEqual([])
  const r = await $.command.run({ command: 'filetree', args: '' })
  expect(r.text).toContain('opened')
  expect(opens).toEqual(['filetree'])
})
