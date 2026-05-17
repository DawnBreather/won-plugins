---
name: create-docker-workspace
description: Scaffold a new Docker developer workspace (compose trio + Dockerfile + entrypoint + Taskfile entries). Use when the user says "add workspace", "create workspace", "new workspace", or "scaffold workspace".
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

# Create Docker Workspace

Scaffold a new per-project developer workspace inside `/home/won/lab/docker-workspaces`.

## What gets created

Each workspace is a **trio** of compose services sharing a Tailscale network namespace:

1. **tailscale-`<name>`** — Tailscale sidecar (owns netns, ephemeral auth).
2. **dind-`<name>`** — Docker-in-Docker sidecar (privileged, tcp://127.0.0.1:2375).
3. **workspace-`<name>`** — Dev container (SSH over tailnet, all tools).

Plus supporting files:
- `Dockerfile.<name>` — extends `docker-workspaces/base:latest` with project-specific deps.
- `entrypoint-<name>.sh` — optional custom boot script (only if project needs it).
- Entries in `Taskfile.yml` (`build:<name>`, `up:<name>`).
- Named volumes declaration in `docker-compose.yml`.

## Gather info

Before scaffolding, ask the user (use AskUserQuestion):

1. **Workspace name** — short kebab-case slug, becomes the Tailscale hostname with `-ws` suffix (e.g. `church` → `church-ws`). Must be unique.
2. **Project path** — host path under `~/lab/` (e.g. `/home/won/lab/church`).
3. **Extra apt packages** — project-specific system deps (e.g. `ffmpeg`, `libpq-dev`). Can be empty.
4. **Extra mise tools** — project-specific tools beyond base image (e.g. `go@latest`). Can be empty.
5. **Custom entrypoint logic** — any boot-time wiring (symlinks, env files, service startup). Can be empty.
6. **Extra bind mounts** — project-specific host paths to mount (e.g. `~/.hermes`). Can be empty.

## Scaffold steps

### 1. Read current state

Read these files to understand existing structure:
- `docker-compose.yml` — to append after last workspace block
- `Taskfile.yml` — to add build/up tasks
- `Dockerfile.base` — for reference (don't modify)

### 2. Create Dockerfile.<name>

```dockerfile
# syntax=docker/dockerfile:1.7

FROM docker-workspaces/base:latest

# <name>-specific setup. Edit this file to add project deps.
```

If extra apt packages provided:
```dockerfile
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
        <packages> \
    && rm -rf /var/lib/apt/lists/*
```

If extra mise tools provided:
```dockerfile
USER won
RUN mise use -g -y <tools> && mise reshim
```

Always end with:
```dockerfile
USER root
COPY --chmod=0755 entrypoint-<name>.sh /usr/local/bin/entrypoint-<name>.sh
ENTRYPOINT ["/usr/local/bin/entrypoint-<name>.sh"]
```

Or if no custom entrypoint needed, just inherit base's entrypoint (omit COPY+ENTRYPOINT).

### 3. Create entrypoint-<name>.sh (if custom logic needed)

Base pattern — copy from `entrypoint.sh` and add project-specific logic before `exec sshd`:

```bash
#!/usr/bin/env bash
set -euo pipefail

USERNAME="${WORKSPACE_USER:-won}"
USER_HOME="$(getent passwd "$USERNAME" | cut -d: -f6)"

# --- sshd host keys (same as base) ---
if ! ls /var/lib/sshd-keys/ssh_host_*_key >/dev/null 2>&1; then
    ssh-keygen -t rsa     -b 4096 -f /var/lib/sshd-keys/ssh_host_rsa_key     -N '' -q
    ssh-keygen -t ecdsa           -f /var/lib/sshd-keys/ssh_host_ecdsa_key   -N '' -q
    ssh-keygen -t ed25519         -f /var/lib/sshd-keys/ssh_host_ed25519_key -N '' -q
fi
chmod 600 /var/lib/sshd-keys/ssh_host_*_key
chmod 644 /var/lib/sshd-keys/ssh_host_*_key.pub

install -d -m 0700 -o "$USERNAME" -g "$USERNAME" "$USER_HOME/.ssh"

# --- volume ownership fix ---
for p in \
    "$USER_HOME/.azure" \
    "$USER_HOME/.config/gh" \
    "$USER_HOME/.config/glab" \
    "$USER_HOME/.config/mise" \
    "$USER_HOME/.local/state" \
    "$USER_HOME/.local/share/mise" \
    "$USER_HOME/.cache/mise" \
    "$USER_HOME/.cache/ms-playwright" \
    "$USER_HOME/.cache/zellij"
do
    mkdir -p "$p"
    if [[ "$(stat -c %u "$p")" != "$(id -u "$USERNAME")" ]]; then
        chown -R "$USERNAME:$USERNAME" "$p"
    fi
done

# --- <name>-specific boot logic here ---

exec /usr/sbin/sshd -D -e
```

If no custom logic → skip this file entirely; Dockerfile inherits base entrypoint.

### 4. Append to docker-compose.yml

Add the trio block after the last workspace section, before `volumes:`. Follow the existing pattern exactly. The standard bind mounts are:

```yaml
  tailscale-<name>-ws:
    <<: *tailscale-base
    container_name: tailscale-<name>-ws
    hostname: <name>-ws
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY:?TS_AUTHKEY env required}
      TS_HOSTNAME: <name>-ws
      TS_EXTRA_ARGS: --advertise-tags=${TAILNET_TAG:-tag:dev-workspace}
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
    volumes:
      - tailscale-<name>-ws-state:/var/lib/tailscale

  dind-<name>-ws:
    <<: *dind-base
    container_name: dind-<name>-ws
    network_mode: service:tailscale-<name>-ws
    depends_on:
      tailscale-<name>-ws:
        condition: service_started
    volumes:
      - dind-<name>-ws-data:/var/lib/docker

  workspace-<name>-ws:
    <<: *workspace-base
    container_name: workspace-<name>-ws
    build:
      context: .
      dockerfile: Dockerfile.<name>
    image: docker-workspaces/<name>:latest
    network_mode: service:tailscale-<name>-ws
    environment:
      DOCKER_HOST: tcp://127.0.0.1:2375
      HOSTNAME: <name>-ws
    depends_on:
      tailscale-<name>-ws:
        condition: service_started
      dind-<name>-ws:
        condition: service_started
    volumes:
      # --- host-matched bind mounts ---
      - type: bind
        source: /home/won/.ssh/won.pub
        target: /home/won/.ssh/authorized_keys
        read_only: true
      - type: bind
        source: /home/won/.ssh/won
        target: /home/won/.ssh/won
        read_only: true
      - type: bind
        source: /home/won/.ssh/won.pub
        target: /home/won/.ssh/won.pub
        read_only: true
      - type: bind
        source: /home/won/.ssh/known_hosts
        target: /home/won/.ssh/known_hosts
      - type: bind
        source: /home/won/.config/.env.d
        target: /home/won/.config/.env.d
        read_only: true
      - type: bind
        source: /home/won/.config/zellij
        target: /home/won/.config/zellij
      - type: bind
        source: /home/won/.zshrc
        target: /home/won/.zshrc
        read_only: true
      - type: bind
        source: /home/won/.zshenv
        target: /home/won/.zshenv
        read_only: true
      - type: bind
        source: /home/won/.zsh_history
        target: /home/won/.zsh_history
      - type: bind
        source: /home/won/.config/starship.toml
        target: /home/won/.config/starship.toml
        read_only: true
      - type: bind
        source: /home/won/.claude
        target: /home/won/.claude
      - type: bind
        source: /home/won/.claude.json
        target: /home/won/.claude.json
      - type: bind
        source: /home/won/.mcp.json
        target: /home/won/.mcp.json
      - type: bind
        source: /home/won/.mcp
        target: /home/won/.mcp
        read_only: true
      - type: bind
        source: /home/won/.mempalace
        target: /home/won/.mempalace
      - type: bind
        source: /home/won/lab
        target: /home/won/lab
      # --- per-workspace persistent state ---
      - workspace-<name>-ws-sshkeys:/var/lib/sshd-keys
      - workspace-<name>-ws-mise:/home/won/.local/share/mise
      - workspace-<name>-ws-mise-cache:/home/won/.cache/mise
      - workspace-<name>-ws-mise-config:/home/won/.config/mise
      - workspace-<name>-ws-state:/home/won/.local/state
      - workspace-<name>-ws-gh:/home/won/.config/gh
      - workspace-<name>-ws-glab:/home/won/.config/glab
      - workspace-<name>-ws-azure:/home/won/.azure
      - workspace-<name>-ws-playwright:/home/won/.cache/ms-playwright
      - workspace-<name>-ws-zellij-cache:/home/won/.cache/zellij
```

Add any extra bind mounts from user input. Add extra named volumes if custom entrypoint creates new volume-backed paths.

Declare all new named volumes in the `volumes:` section at bottom:

```yaml
  tailscale-<name>-ws-state:
  dind-<name>-ws-data:
  workspace-<name>-ws-sshkeys:
  workspace-<name>-ws-mise:
  workspace-<name>-ws-mise-cache:
  workspace-<name>-ws-mise-config:
  workspace-<name>-ws-state:
  workspace-<name>-ws-gh:
  workspace-<name>-ws-glab:
  workspace-<name>-ws-azure:
  workspace-<name>-ws-playwright:
  workspace-<name>-ws-zellij-cache:
```

### 5. Add Taskfile entries

Append to `Taskfile.yml`:

```yaml
  build:<name>:
    desc: Build <name>-ws image (depends on base).
    deps: [build:base]
    cmds:
      - docker compose build workspace-<name>-ws

  up:<name>:
    desc: Start the <name>-ws stack (tailscale + dind + workspace).
    deps: [build:<name>]
    cmds:
      - docker compose up -d tailscale-<name>-ws dind-<name>-ws workspace-<name>-ws
```

Also add `build:<name>` to the `build` task's `deps` list.

### 6. Validate

```bash
docker compose config --quiet && echo "compose OK"
task --list
```

### 7. Report

Print summary:
- Files created/modified
- How to build: `task build:<name>`
- How to start: `task up:<name>`
- How to SSH: `ssh won@<name>-ws`
- Remind: first boot needs Tailscale auth key in `.env`
