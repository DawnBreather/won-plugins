---
name: create-plugin-skill
description: Use when the user wants to add a new skill to an existing Claude Code plugin. Creates SKILL.md with proper frontmatter inside the plugin's skills directory.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

# Create Plugin Skill

Add a new skill to an existing plugin in a marketplace.

## Gather info

Ask the user (use AskUserQuestion):

1. **Marketplace** — pick from `~/.claude/plugins/marketplaces/` (exclude `claude-plugins-official`).
2. **Plugin** — pick from `plugins/` subdirs in chosen marketplace.
3. **Skill name** — kebab-case slug. Becomes the invocation name (`/<plugin>:<skill-name>`).
4. **Description** — starts with "Use when...". Describes triggering conditions only (NOT what the skill does). Max ~500 chars.
5. **What should this skill do?** — free text. The user describes the skill's purpose, patterns, or workflow. This becomes the body content.

## Scaffold

### 1. Locate plugin

```bash
MP="$HOME/.claude/plugins/marketplaces/<marketplace>"
PLUGIN_DIR="$MP/plugins/<plugin>/skills/<skill-name>"
```

### 2. Create skill directory + SKILL.md

```
$PLUGIN_DIR/
└── SKILL.md
```

### 3. Write SKILL.md

```markdown
---
name: <skill-name>
description: <description starting with "Use when...">
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

# <Skill Title>

<Body content based on user's description. Structure with:>

## When to Use
<Triggering conditions, symptoms, use cases>

## <Core sections based on skill type>
<Concrete commands, patterns, examples>

## Gotchas
<Common mistakes, edge cases>
```

**Frontmatter rules** (from agentskills.io spec):
- `name`: letters, numbers, hyphens only. No parens or special chars.
- `description`: max 1024 chars total frontmatter. Start with "Use when...". Third person. Do NOT summarize workflow — only triggering conditions.
- `user-invocable: true` if user can call directly via `/`.
- `allowed-tools`: list tools the skill needs.

**Body guidelines:**
- Under 200 lines.
- Concrete commands over prose.
- One excellent example beats many mediocre ones.
- Tables for quick reference.
- No narrative storytelling.

### 4. Commit + push

```bash
cd "$MP"
git add -A
git commit -m "feat(<plugin>): add <skill-name> skill"
git push
```

### 5. Reload

Tell user:
```
/plugin update <plugin>@<marketplace>
/reload-plugins
```

### 6. Report

Print: skill path, invocation (`/<plugin>:<skill-name>`), description.
