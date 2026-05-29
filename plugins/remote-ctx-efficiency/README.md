# remote-ctx-efficiency

A Claude Code plugin that injects a standing **SessionStart** reminder: local
token-saving proxies (`rtk`, `context-mode`) do **not** reach inside
`ssh host '...'`, so output-heavy remote work should be wrapped in `ctx_execute`
— or run on the remote host directly.

## Why

- `rtk`'s `PreToolUse(Bash)` hook rewrites only *bare local* commands. It sees
  the outer `ssh ...` string but never the quoted remote command, so the remote
  output runs raw at full token cost.
- `context-mode` doesn't transparently wrap `ssh` output from a plain `Bash`
  call — you have to route through its `ctx_*` tools.

A session that does most of its work over `ssh` therefore gets near-zero benefit
from either proxy. This plugin keeps that fact in front of Claude every session.

## How it works

Mirrors the caveman / superpowers pattern: a SessionStart hook
(`hooks/inject-remote-ctx-habit.sh`) writes guidance to stdout, which Claude
Code injects as hidden session context. **No files are mutated** — no
`CLAUDE.md` is touched. Disable the plugin and the habit is gone instantly.

The hook is pure POSIX `sh` (a static heredoc) with **no node/bun/python
dependency**, so it runs under any shell Claude Code uses to invoke it — even on
a box where `node` isn't on the hook's PATH (e.g. a Nushell-default macOS host).

A companion skill (`remote-token-efficiency`) carries the full how-to for
on-demand deep reference.

## Install

```
/plugin marketplace add DawnBreather/won-plugins
/plugin install remote-ctx-efficiency@won-plugins
```

Restart Claude Code to activate the hook.

## What it nudges

Wrap remote `cat` / `ls` / `grep` / `ps` / `du` / `find` / `tail` /
`journalctl` / log + config dumps in:

```
ctx_execute(language: "shell", code: "ssh syk 'kubectl get pods -A'")
```

Plain `ssh` stays correct for short fixed observations (`whoami`, clean
`git status`) and state mutations (`git`, `rm`, `systemctl`).
