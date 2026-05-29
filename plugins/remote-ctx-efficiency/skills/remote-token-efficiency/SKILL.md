---
name: remote-token-efficiency
description: Use when running output-heavy commands over ssh on a remote host. Explains why rtk/context-mode don't filter ssh output and how to keep raw remote bytes out of the context window using ctx_execute or by running Claude on the remote host.
license: MIT
---

# Remote Token Efficiency

Local token-saving proxies are blind to anything inside `ssh host '...'`. This
skill is the full reference behind the standing SessionStart reminder this
plugin injects.

## Why the local proxies don't help over ssh

- **rtk** installs a `PreToolUse(Bash)` hook that rewrites *bare local* commands
  (`git status` → `rtk git status`). When the Bash command is `ssh syk 'cat
  /etc/foo'`, the hook only sees the **outer** `ssh ...` string. It does not —
  and cannot — descend into the quoted remote command. The remote `cat` runs
  raw and its full output lands in your context window.
- **context-mode** saves context by running work in a sandbox via its `ctx_*`
  tools. It does not transparently intercept `ssh` output from a plain `Bash`
  call; you have to *route* the command through it.

Net effect: a session that does most of its work as `ssh host '...'` gets
near-zero benefit from either proxy unless you change how you invoke things.

## Two ways to fix it

### 1. Run Claude on the remote host (best for substantial work)

If the host has rtk + context-mode installed, start a Claude session **there**.
Then every command is local to that host and both proxies work natively. No
ssh wrapping, no lost savings.

### 2. Wrap remote commands in `ctx_execute` (best from your laptop)

Keep the raw bytes in the sandbox; only your derived answer enters context:

```
ctx_execute(language: "shell", code: "ssh syk 'kubectl get pods -A'")
```

Then `console.log` only the conclusion you need (a count, the failing rows, a
summary). For multiple remote captures in one round trip, use
`ctx_batch_execute` with descriptive labels.

## When it applies — and when it doesn't

**Apply** to remote output you intend to filter / count / parse / summarize:
`cat`, `ls -la`, `grep -r`, `ps aux`, `du -sh`, `find`, `tail -n`, `journalctl`,
config dumps, log files, `kubectl get … -o yaml`.

**Skip** (plain `ssh` is correct) for:
- Short fixed observations you just glance at: `whoami`, `pwd`, a clean
  `git status`, a one-line version check.
- State mutations: `git`, `mkdir`, `rm`, `mv`, `systemctl restart`, `kubectl
  apply`. These change the world; don't route them for "savings".

## Rule of thumb

If you're about to read a big remote dump into the conversation to then pick
through it — wrap it. If you're mutating remote state or glancing at a couple
fixed lines — plain `ssh`.
