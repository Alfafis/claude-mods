# Contributing

Contributions are welcome. Because every mod runs code on the machine of whoever installs it, review is strict.

## Flow

1. For anything beyond a small fix, open an issue first and wait for a go-ahead.
2. Fork, branch from `main`, one plugin per PR.
3. Validate and test:

```bash
claude plugin validate plugins/<name>
claude plugin test plugins/<name>   # plain `bun test` does not run: the engine module is missing
```

4. Open the PR and fill in the checklist. Every PR needs the maintainer's approval and a green `guard` check before merging.

## Rules for every PR

- One plugin per feature; the plugin name is part of the `$.state` keys.
- A `tool.call` hook is an observer: `await next()`, then record, inside `try/catch`; never change the result.
- No network, no process execution and no reads or writes outside the project or `~/.claude` **without prior discussion in the issue**. If there is any, state in the PR what, why and how it is bounded.
- Git always with `--no-optional-locks` and `-c core.fsmonitor=false`.
- Draw with `$.ui.resolve(e)` and keep every surface in mind: `Raster` and `Image` exist only on the terminal, `Svg` only elsewhere. Add your plugin's pane to a test that mounts it on `terminal`, `desktop`, `vscode` and `mobile`.
- No new dependencies without a reason. No minified or obfuscated code.
- Never commit credentials, personal paths or session data. Screenshots with real data must be anonymized.
- Comments only for a non-obvious why. Conventional Commits (`feat`, `fix`, `docs`...).
- Third-party code keeps its original license and credit inside the plugin's folder.

## Releasing (maintainer)

`marketplace.json` pins every plugin to a commit `sha`, so a merge into `main` never reaches users on its own.

1. Merge the reviewed PR and bump the plugin's `version` in its `plugin.json`.
2. Open a PR that sets each changed plugin's `sha` in `.claude-plugin/marketplace.json` to the merged commit.
3. Tag the release `<plugin>-v<version>`.

## License

By contributing you agree your contribution is licensed under the MIT license, like the rest of the repository.

See also [SECURITY.md](SECURITY.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
