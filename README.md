# claude-mods

**English** · [Português](README.pt-BR.md)

A marketplace of mods for Claude Code. Each feature is an independent plugin under `plugins/`, so a failure in one does not take down the others. Open source, contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Plugins

| Plugin | Version | What it does |
|---|---|---|
| `filetree` | 0.7.3 | File tree panel: folders on demand, search, paged preview (diff or content) on click, names colored by git state, files Claude reads and writes, sensitive-file alert, warning when editing on `main` or over your uncommitted changes, and optional GitHub PR/CI/review through `gh` |
| `crew` | 0.4.0 | Subagent panel (`/crew`): one card per agent with an animated crab, role, current tool, answer, context, time and estimated cost (`~$`) |
| `meter` | 0.1.5 | Main conversation context and cost: `/meter` panel with the window by category, what each turn added, cost per turn and limits; a one-time warning when context passes `warnAt` |
| `recall` | 0.1.0 | Search the text of past sessions (`/recall <words>`): this project or all, with the id for `claude --resume` |

Panels open as tabs beside the chat (`/filetree`, `/crew`, `/meter`, `/recall`). After `/reload-plugins` the tabs close and are reopened by their command.

<img src="docs/img/filetree.png" alt="Files panel: git branch with a warning when Claude edited something, file preview and a tree with icons and git-state colors" width="300"> <img src="docs/img/meter.png" alt="Context panel: context percentage, window by category, memory files, session cost and limits" width="300">

<img src="docs/img/crew.png" alt="Crew panel: one card per subagent with an animated crab, context meter, output, estimated cost, steps, model and time" width="300"> <img src="docs/img/recall.png" alt="Recall panel: search box and a project / all projects scope" width="300">

## Install

**Terminal.** Register the marketplace once, then install only the mods you want:

```
claude plugin marketplace add Alfafis/claude-mods
claude plugin install filetree@alfafis-mods
claude plugin install meter@alfafis-mods
claude plugin install recall@alfafis-mods
claude plugin install crew@alfafis-mods
```

**Claude desktop app, Code tab.** `/plugin` does not run there. Click **+** next to the prompt box, then *Plugins*, *Add marketplace* with `Alfafis/claude-mods`, then *Add plugin*. The app's Chat tab does not load mods.

Every plugin is pinned to a commit in `marketplace.json`: a merge into `main` does not reach you until the maintainer publishes a release. To update: `claude plugin marketplace update alfafis-mods`. To develop from a local copy, use the path instead of the repo: `claude plugin marketplace add /path/to/claude-mods`.

**Security:** each mod runs code on your machine, in hooks on every tool call. Read the code before installing. Vulnerabilities: see [SECURITY.md](SECURITY.md).

After installing or changing code, run `/reload-plugins`. Options (`/plugin configure <plugin>@alfafis-mods`) only apply after restarting Claude Code.

## Surfaces

The mods draw on the terminal and on the desktop app's Code tab; tests also run them on the `vscode` and `mobile` surfaces. The tests check the hooks and the tree each surface accepts, not how the desktop app paints it. On the desktop app `crew` draws the crab as an `Svg` and redraws the panel twice a second while an agent runs.

## Options

| Plugin | Option | Default | Effect |
|---|---|---|---|
| `filetree` | `autoOpen` | on | opens the panel at the start of every session; off, only with `/filetree` |
| `filetree` | `icons` | `nerd` | `nerd` (needs a Nerd Font), `dot` or `none` |
| `filetree` | `github` | off | queries the branch's PR, checks and review through `gh` |
| `filetree` | `githubRefreshSeconds` | 300 | minimum interval between queries |
| `crew` | `autoOpen` | on | opens the panel on the first subagent |
| `crew` | `maxCards` | 30 | soft card limit, never drops a running agent |
| `crew` | `compactFinished` | off | finished agents in 2 lines, no crab |
| `crew` | `groupByParent` | on | nested agents under the one that created them |
| `crew` | `contextWindow` | 200000 | window size in tokens for each card's context meter (8000 to 2000000) |
| `crew` | `prices` | empty | JSON of prices per model (USD per million tokens); without it there is no `~$` |
| `meter` | `autoOpen` | on | opens the `Context` panel at the start of every session; off, only with `/meter` |
| `meter` | `band` | off | context and cost line above the prompt |
| `meter` | `limits` | on | 5 h and 7 d windows in the line and the panel |
| `meter` | `warnAt` | 80 | context % that triggers the warning (50 to 95) |
| `recall` | `scope` | `project` | `project` or `all` (every folder in `~/.claude/projects`) |

## What each one does not do

- `crew`: cost is an estimate from the `prices` table and each step's `usage`, not the invoice. Cache writes with a 1 h TTL cost double and `usage` does not separate the TTL; price tiers by prompt size are not modeled.
- `meter`: percentage and window are the compaction ones (what triggers autocompact), which can be smaller than the model window; the panel says so. Cost and limits come from the engine. Limits exist only on a subscription. A compaction shows as a `compacted` marker above the categories, not as a drop per category.
- `recall`: reads local history only, on macOS and Linux. It uses the ripgrep bundled in the Claude Code binary (`ARGV0=rg`, an internal detail that may change) and `rg` from `PATH` as a fallback. Credentials are masked heuristically; the `all` scope shows text from other projects.
- `filetree`: git always runs with `--no-optional-locks` and without fsmonitor, so it neither blocks Claude's commit nor runs code from a cloned repo's config.

## Notice about `crew`

The crab comes from [crab-band](https://github.com/MaxHarfen/crab-band) (MIT), which states it is drawn after Clawd, Claude Code's mascot by Anthropic, and is not supported by Anthropic. The MIT covers the authors' work, not the character: rights in Clawd stay with Anthropic, and this project is not affiliated with or endorsed by it. If the rights holder asks, the art is removed or replaced. Details in `plugins/crew/NOTICE.md`.

## Conventions

- One plugin per feature, each with its own `.claude-plugin/plugin.json`.
- Engine state belongs to the owning plugin: the plugin name is part of the `$.state` keys.
- Third-party code keeps its original license and credit inside the plugin's folder.
- Test and validate: `claude plugin validate plugins/<name>` and `claude plugin test plugins/<name>` (plain `bun test` does not run: the engine module is missing).
