# claude-plugins

Personal Claude Code plugin marketplace.

## Plugins

| Plugin | Skills | Description |
|--------|--------|-------------|
| `workspace` | `create-docker-workspace` | Scaffold per-project Docker dev workspaces (Tailscale SSH + DinD + compose trios) |

## Install

```
/plugin marketplace add DawnBreather/claude-plugins
/plugin install workspace@claude-plugins
/reload-plugins
```

## Usage

```
/workspace:create-docker-workspace
```

## Adding a new plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json`
2. Add skills under `plugins/<name>/skills/<skill-name>/SKILL.md`
3. Register in `.claude-plugin/marketplace.json` under `plugins[]`
4. Commit + push
