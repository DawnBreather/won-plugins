# won-plugins

Personal Claude Code plugin marketplace.

## Setup

```
/plugin marketplace add DawnBreather/won-plugins
```

## Plugins

| Plugin | Skills | Category | Description |
|--------|--------|----------|-------------|
| `workspace` | `create-docker-workspace` | devops | Scaffold per-project Docker dev workspaces (Tailscale SSH + DinD + compose trios) |
| `plugin` | `create-marketplace`, `create-plugin`, `create-plugin-skill` | productivity | Scaffold Claude Code marketplaces, plugins, and skills |
| `nano-banana` | `generate-and-vectorize` | ai | AI image generation/editing/upscaling via Gemini (MCP + workflow skills) |

## Install individual plugins

```
/plugin install workspace@won-plugins
/plugin install plugin@won-plugins
/plugin install nano-banana@won-plugins
/reload-plugins
```

## Usage

```
/workspace:create-docker-workspace    # scaffold a new Docker workspace
/plugin:create-marketplace            # scaffold a new marketplace repo
/plugin:create-plugin                 # add plugin to existing marketplace
/plugin:create-plugin-skill           # add skill to existing plugin
/nano-banana:generate-and-vectorize   # generate image + vectorize to SVG
```

nano-banana also provides MCP tools (auto-registered on install):
- `mcp__nano-banana__generate_image` — text-to-image via Gemini
- `mcp__nano-banana__edit_image` — edit existing image with prompt + optional references
- `mcp__nano-banana__upscale_image` — AI upscale to 4K

## Requirements

- `bun` on PATH (for nano-banana MCP server)
- `GEMINI_API_KEY` env var (for nano-banana)
- `rembg`, `vtracer`, `potrace` (for generate-and-vectorize workflow)

## Adding a new plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json`
2. Add skills under `plugins/<name>/skills/<skill-name>/SKILL.md`
3. Register in `.claude-plugin/marketplace.json` under `plugins[]`
4. Commit + push
5. Users run `/plugin update <name>@won-plugins` to pick up changes
