---
name: push-to-sanity
description: Use when per-ad markdown files exist in `.church-ads.raw/YYYYMMDD.church-ads/` (output of /church-ads:process-ads) and the user wants to push them as event documents to the CCS Seattle Sanity CMS. Triggers on "push ads to Sanity", "publish today's announcements", "push to CMS", or `/church-ads:push-to-sanity`. Two-step: build a merge plan, user reviews/edits, then apply.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

# Push Ads to Sanity

Two-step push: build a merge plan, let the user review, then apply.

## When to Use

After `/church-ads:process-ads` produced `{NN}-{slug}.md` files plus `regen-{slug}.{en,ko}.png` images. Run this to push to the live CMS — Sanity webhook triggers a Cloudflare Pages rebuild.

## Pipeline

### Step 1 — Build context dump

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/build-merge-context.ts \
  --out "$RAW_DIR" \
  --studio-env "<repo>/studio/.env"
```

Fetches every existing Sanity event with full bilingual fields and writes `<RAW_DIR>/MERGE_CONTEXT.md` — a structured dump of all events plus all new ads from `segments.json`.

### Step 2 — LLM decides merge plan

**You (the Claude Code session running this skill) read MERGE_CONTEXT.md and decide.** This is delegated reasoning, not an algorithmic match. Take time to think carefully about each ad. Use:
- The full bilingual title, date, time, location, description for every existing event
- The Korean/English titles + descriptions of new ads
- The voice transcript chunk attached to each ad (gives context the slide alone may not)

**Decision categories:**
- `new` — distinct event, no existing record
- `merge: <_id>` — refresh of an existing recurring or series event (Friday prayer next week, monthly devotional, current cohort of a class)
- `skip` — duplicate within this batch, or content not worth publishing

**Heuristics to apply:**
- Recurring weekly/monthly events that already exist in Sanity = merge (same event document, new image + date)
- Same series, same cohort/instance number = merge
- New cohort/year of a series ("23rd" replacing "22nd") = `new` only if the prior is fully concluded
- Different scope under same ministry (golf tournament vs men's general gathering) = separate
- Past existing event with no recurrence + new future event of similar topic = usually `new`

Write the result to `<RAW_DIR>/MERGE_PLAN.md`. Per ad include a `reasoning:` block explaining the decision. The user can override anything before applying.

### Step 3 — Apply

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/apply-plan.ts \
  --out "$RAW_DIR" \
  --studio-env "<repo>/studio/.env"
```

For each non-skipped ad:
1. Uploads `regen-{slug}.en.png` + `regen-{slug}.ko.png` as a single `images[0] = { en, ko }` pair
2. Uploads any `extra_images:` filenames -> additional `images[N]` entries (same image used for both langs)
3. `new` -> `createOrReplace` w/ `_id = event-{slug}`
4. `merge: <id>` -> `patch(id).set(doc)` — preserves `_id`
5. `skip` -> nothing
6. If any new ad has `primary: true`, clears `primary` on all other events first (hero exclusivity)

## MERGE_PLAN.md format

```markdown
# Merge Plan — YYYYMMDD

## 01 — <Title EN> / <Title KO>

reasoning: |
  <Why this decision was made — recurring? series? distinct?>

```yaml
ad_index: 1
slug: father-school-golf-tournament
action: merge: 793e90c1-cff1-4cf5-84af-c8fd4f5c428a
featured: true
primary: false
publish_end_date: 2026-05-31
extra_images:
```
```

The apply script parses only the `yaml` blocks. The `reasoning:` paragraphs are for human review.

## Action grammar

| Value | Effect |
|-------|--------|
| `new` | Create `event-{slug}` |
| `merge: <_id>` | Overwrite that existing event |
| `skip` | No-op |

## Multi-image support

`extra_images: file1.png, file2.png` (comma-separated, files in `<RAW_DIR>`). Become `images[1..]`. Hero card always uses `images[0]`.

To produce extras, drop additional PNGs in `<RAW_DIR>` before running apply — for example a photo of the actual venue.

## Bilingual fallback

`images[].en` and `images[].ko` are independent. Frontend shows the current-language image; if missing, falls back to the other language; if both missing, uses `fallbackGradient`. Editor is free to set just one language.

## Hero exclusivity

The Studio's `exclusiveHeroPublishAction` enforces this on UI publish. The apply script enforces it on push. Setting `primary: true` on any ad in the plan automatically unsets `primary` on every other event in Sanity.

## publishEndDate

Optional `YYYY-MM-DD`. Events past this date are filtered out at GROQ build time. Daily GitHub Actions cron triggers a Cloudflare rebuild at 04:00 PT so ended events drop out without manual intervention.

## Verification

```bash
cd <repo>/studio && export $(cat .env | xargs)
node -e "
import('@sanity/client').then(({createClient}) => {
  const c = createClient({projectId:process.env.SANITY_STUDIO_PROJECT_ID, dataset:'production', apiVersion:'2025-01-01', useCdn:false, token:process.env.SANITY_AUTH_TOKEN});
  c.fetch('*[_type==\"event\" && _id in \$ids]{_id,title,featured,primary,publishEndDate,\"images\":count(images)}', {ids: [...]}).then(d => console.log(JSON.stringify(d, null, 2)));
})
"
```

## Live URL

`https://ccs-events-seattle.pages.dev` — rebuild ~1-2 min after push (webhook from Sanity).

## Gotchas

- **`bunx tsc --noEmit`** before running: the apply script uses `@sanity/client` typings.
- **Image upload is one-shot** — re-running the apply step uploads new asset instances. Don't loop.
- **Korean text quality**: review per-ad MD output before applying; machine translations sometimes miss church terminology.
- **`publishEndDate` filter is build-time**: changes only take effect after next rebuild (auto-cron at 11:00 UTC = 04:00 PT, or manual hook).
