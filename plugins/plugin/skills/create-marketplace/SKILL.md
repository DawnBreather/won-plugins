---
name: create-marketplace
description: Use when the user wants to create a new Claude Code plugin marketplace GitHub repo. Scaffolds marketplace.json, README, and initial directory structure.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
---

# Create Marketplace

Scaffold a new Claude Code plugin marketplace as a GitHub repo.

## Gather info

Ask the user (use AskUserQuestion):

1. **GitHub owner/repo** — e.g. `MyOrg/my-plugins`. Repo will be created.
2. **Marketplace name** — short slug (no `claude`/`anthropic` in name — blocked by validation). e.g. `won-plugins`, `acme-tools`.
3. **Description** — one-line.
4. **Visibility** — public or private.

## Scaffold

### 1. Create local directory

```
/tmp/<marketplace-name>/
├── .claude-plugin/
│   └── marketplace.json
└── README.md
```

### 2. Write `.claude-plugin/marketplace.json`

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "<marketplace-name>",
  "description": "<description>",
  "owner": {
    "name": "<user name from git config>",
    "url": "https://github.com/<owner>"
  },
  "plugins": []
}
```

**Validation rules** (will fail install if violated):
- `name` must NOT contain `claude`, `anthropic`, or `official` (case-insensitive).
- `name` should be kebab-case.
- `plugins` array starts empty — plugins added via `/plugin:create-plugin`.

### 3. Write README.md

Include: marketplace name, install commands (`/plugin marketplace add <owner>/<repo>`), table of plugins (empty initially), "Adding a plugin" section.

### 4. Git init + push

```bash
cd /tmp/<marketplace-name>
git init && git add -A
git commit -m "feat: initial marketplace scaffold"
gh repo create <owner>/<repo> --<visibility> --source=. --push \
  --description "<description>"
```

### 5. Register locally

Tell user to run:
```
/plugin marketplace add <owner>/<repo>
```

### 6. Report

Print: repo URL, next step (`/plugin:create-plugin` to add first plugin).
