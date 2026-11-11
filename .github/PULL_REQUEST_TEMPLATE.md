## What changes

<!-- Affected plugin and a summary. One plugin per PR. -->

## Security checklist

- [ ] Uses the network? (if so, explain and link the approved issue)
- [ ] Runs processes? (command, arguments, where they come from)
- [ ] Reads or writes outside the project or `~/.claude`?
- [ ] Adds a dependency or third-party code?
- [ ] No credentials, personal paths or session data in the diff or screenshots

## Validation

- [ ] `claude plugin validate plugins/<name>`
- [ ] `claude plugin test plugins/<name>`
- [ ] Tested every surface the pane draws on (`terminal`, `desktop`, `vscode`, `mobile`)
- [ ] Ran the mod locally
