# Security

The mods in this repository run local code in `tool.call` hooks and read Claude Code state (project files, session history in `~/.claude/projects`). A bug here can expose data or run code on the machine of whoever installs it.

## Reporting a vulnerability

Do not open a public issue. Use GitHub **Private Vulnerability Reporting**: *Security* tab, then *Report a vulnerability*.

Include the plugin, the version, the steps to reproduce and the impact. First reply within 7 days; a fix or a plan within 30.

## Scope

In scope: unexpected code or command execution, reads or writes outside what is expected, credential leaks, bypass of the documented protections (masking in `recall`, git without fsmonitor in `filetree`).

Out of scope: the Claude Code mod engine itself (report it to Anthropic) and third-party plugins.

## Supported versions

Only the latest release of each plugin, the commit pinned in `marketplace.json` on `main`.
