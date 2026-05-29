#!/usr/bin/env sh
# remote-ctx-efficiency — SessionStart hook
#
# Injects a standing reminder that the local token-saving proxies (rtk,
# context-mode) do NOT reach inside `ssh host '...'`, so output-heavy remote
# work should be wrapped in ctx_execute (or run on the remote host directly).
#
# Mechanism mirrors caveman/superpowers: write guidance to stdout; Claude Code
# injects it as hidden SessionStart context. No files mutated, no CLAUDE.md
# touched — disabling the plugin removes the habit instantly.
#
# Pure POSIX sh — NO node/bun/python dependency. The payload is static text, so
# it runs under any shell Claude Code uses to invoke the hook (sh, bash, zsh,
# even when node is absent from PATH, e.g. a Nushell-default macOS box).
# Best-effort: the heredoc cannot fail in a way that blocks session start.

cat <<'HABIT'
REMOTE TOKEN EFFICIENCY — active this session.

Local token-saving proxies do NOT reach inside `ssh host '...'`:
  • rtk's Bash hook only rewrites BARE LOCAL commands. `ssh syk 'cat x'` passes
    through untouched — the remote command runs raw, at full token cost.
  • context-mode's ctx tools do not auto-wrap ssh output either.

So for output-heavy work on a remote host (logs, configs, listings, process
tables, dumps you intend to filter / count / summarize):

  1. Prefer running Claude ON the remote host when the work is substantial and
     that host has the tooling installed (rtk + context-mode work natively there).
  2. Otherwise wrap the remote command in ctx_execute so raw bytes stay in the
     sandbox and only your derived answer enters context:
         ctx_execute(language: "shell", code: "ssh syk 'kubectl get pods -A'")

Applies to remote cat / ls / grep / ps / du / find / tail / journalctl / log
dumps. Does NOT apply to short fixed observations (whoami, a clean git status)
or state mutations (git, mkdir, rm, systemctl) — those stay plain `ssh`.

Off only if the user says so.
HABIT

exit 0
