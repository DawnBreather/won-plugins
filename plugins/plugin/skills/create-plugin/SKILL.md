---
name: create-plugin
description: Use when the user wants to add a new plugin to an existing Claude Code marketplace. Creates plugin.json, skill directory stubs, and registers in marketplace.json.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

# Create Plugin

Add a new plugin to an existing Claude Code marketplace.

## Gather info

Ask the user (use AskUserQuestion):

1. **Marketplace** — which marketplace to add to. List installed marketplaces from `~/.claude/plugins/marketplaces/` (exclude `claude-plugins-official`). User picks one.
2. **Plugin name** — short kebab-case slug. Becomes the colon-namespace prefix (e.g. `devops` → `/devops:<skill>`).
3. **Description** — one-line for plugin.json.
4. **Category** — one of: `productivity`, `devops`, `ai`, `testing`, `documentation`, or custom.

## Scaffold

### 1. Locate marketplace

```bash
MP="$HOME/.claude/plugins/marketplaces/<marketplace-name>"
```

Verify `$MP/.claude-plugin/marketplace.json` exists.

### 2. Create plugin directory

```
$MP/plugins/<plugin-name>/
├── .claude-plugin/
│   └── plugin.json
└── skills/
    └── (empty — skills added via /plugin:create-plugin-skill)
```

### 3. Write `plugin.json`

```json
{
  "name": "<plugin-name>",
  "description": "<description>"
}
```

### 4. Register in marketplace.json

Read `$MP/.claude-plugin/marketplace.json`. Append to `plugins[]`:

```json
{
  "name": "<plugin-name>",
  "description": "<description>",
  "source": "./plugins/<plugin-name>/",
  "category": "<category>"
}
```

Use Edit tool — don't rewrite the whole file.

### 5. Commit + push

```bash
cd "$MP"
git add -A
git commit -m "feat: add <plugin-name> plugin"
git push
```

### 6. Install

Tell user to run:
```
/plugin install <plugin-name>@<marketplace-name>
/reload-plugins
```

### 7. Report

Print: plugin path, available namespace (`/<plugin-name>:<skill>`), next step (`/plugin:create-plugin-skill` to add skills).
