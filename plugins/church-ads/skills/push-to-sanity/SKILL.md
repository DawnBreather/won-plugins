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
7. Carries over the target document's existing `alsoShowIn` unless the ad supplies `also_show_in` (see Categories below) — neither write path may drop a curated chip

Before any of that it aborts if a plan entry's `category_key` or `also_show_in` names a category that does not exist.

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

## Categories (Sanity refs)

Each event carries one primary `category` reference plus an optional `alsoShowIn` array of extra references.

- **`category`** is the badge on the card. Written from the ad's `category_key`.
- **`alsoShowIn`** affects FILTER CHIPS ONLY — it adds no badge and changes nothing else on the card. Written from the ad's optional `also_show_in` (snake_case) array.
- **No cascade, no hierarchy.** `general` does NOT imply `adult` or `college`. A chip lists exactly the events tagged with that chip; membership is never inherited or implied.
- **Extras a pastor curated in Studio are preserved.** `apply-plan.ts` reads the target document's `alsoShowIn` and re-sends it on BOTH paths unless the ad names its own extras — necessary because `createOrReplace` replaces the whole document and `merge` is a full `.set()`. Absent or empty `also_show_in` means "the slide said nothing", not "clear the field"; Gemini emits `[]` freely, so treating it as an instruction would wipe curation on every re-announcement. To ADD or change extras from this pipeline, edit `also_show_in` in `raw/segments.json` (then re-run `validate-segments.ts` and `rewrite-mds.ts`) — `MERGE_PLAN.md` has no key for it. To REMOVE one, edit the event in Studio.
- **A typo'd key is a dangling `_ref`, not an error.** Sanity validates nothing on write, and `alsoShowIn[]->` resolves a dangling ref to a null ENTRY inside the array — the chip silently omits the event. `apply-plan.ts` therefore checks every `category_key` and `also_show_in` entry against the live `*[_type=="category"].key` list and aborts BEFORE the first write, so a bad key cannot half-apply a plan. `validate-segments.ts` catches the same thing offline.

`MERGE_CONTEXT.md` prints `Also shows in` for every existing event (and for any ad that has extras), so the merge decision is made with the curated data visible. A dangling ref renders as `_(dangling ref)_`.

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

## Links over QR codes (policy)

Sign-up actions live in the event's `links[]` (each `{ label, url }`), NOT as a QR code baked into the image. `EventDialog.svelte` renders `links[]` as clickable buttons — that is the canonical CTA path for web visitors. Regenerated images deliberately have NO QR code (see process-ads skill: Gemini-regenerated QRs scan to garbage). Before applying, confirm each ad that had a QR on its source slide has the REAL decoded URL in its `links[]` (verify by decoding the source `raw/page-NN.png`, since the segment step hallucinates fake `forms.gle/...` URLs).

## Gotchas

- **`bunx tsc --noEmit`** before running: the apply script uses `@sanity/client` typings.
- **Image upload is one-shot** — re-running the apply step uploads new asset instances. Don't loop.
- **Korean text quality**: review per-ad MD output before applying; machine translations sometimes miss church terminology.
- **`publishEndDate` filter is build-time**: changes only take effect after next rebuild (auto-cron at 11:00 UTC = 04:00 PT, or manual hook).
- **Merge does a full `.set()` overwrite** — it replaces every field on the target event with the new ad's content. Before choosing `merge`, check the existing event isn't RICHER (e.g. has contact phone numbers the new slide lacks); if so, `skip` to avoid regressing it. `alsoShowIn` is the one field explicitly carried over rather than overwritten; nothing else is, so `MERGE_CONTEXT.md` is still where you check for richer existing content.
- **Re-apply is idempotent for `new` ads** — `createOrReplace` on `_id = event-{slug}` updates in place, so if you spot an error after publishing (bad date, typo), fix segments.json + re-run regen-images.ts + rewrite-mds.ts, then re-run apply-plan.ts. No duplicate is created. (Only caveat: each run uploads fresh image assets — don't loop needlessly.)
- **Slides can contain factual typos** — OCR carries them through verbatim. A final human read catches them (e.g. a printed "2025" that should be "2026"). When corrected, the date/fact lives in THREE places per language: description, full_description, AND the regenerated image (text is baked in) — fix segments.json and regenerate the image, don't just patch the text.
- **GATE: run `validate-segments.ts` before `apply-plan.ts`.** It exits non-zero and blocks the push on every failure class that has actually shipped from this pipeline — camelCase keys that are silently never read, implausible invented years, a date whose weekday contradicts the printed `(Fri)`/`매주 월`, `example.com` placeholder links, a dot in a slug (which makes the Sanity doc private), duplicate slugs, and a `category_key`/`also_show_in` key with no category document behind it (which becomes a dangling `_ref`, then a null entry in the resolved array). Add `--check-urls` to also require every http(s) link to resolve.
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/latest/bin:/opt/homebrew/bin:$PATH"
  cd ~/.claude/plugins/marketplaces/won-plugins/plugins/church-ads
  bun run scripts/validate-segments.ts --out "$RAW_DIR" --check-urls
  ```
- **Schedule keys in `segments.json` are snake_case: `schedule_kind`, `start_date`, `end_date`, `start_time`, `end_time`, `rec_freq`, `rec_weekday`.** That is the exact contract `apply-plan.ts` `scheduleFields()` reads. Writing camelCase (`startDate`, `scheduleKind`) does NOT error and does NOT warn — the key is simply never read, both spellings sit in the same object, and the script keeps using its snake_case key with whatever stale value Gemini put there. On 2026-08-09 Gemini invented year 2020 for undated slides; the free-text `date` field was corrected (so the cards rendered "2026" correctly) but camelCase schedule edits were inert, and three events published with `startDate: "2020-08-31"`, plus a 12-week Monday course stored as `once` instead of `recurring`.
- **Verify structured dates against Sanity after publish, not against the rendered card.** The display string and the structured fields are independent; a correct-looking card proves nothing about `startDate`. One query catches it:
  ```
  *[_type=="event" && (startDate < "2021-01-01" || endDate < "2021-01-01")]{_id, startDate, endDate}
  ```
- **Gemini invents a YEAR for undated slides.** Church slides routinely print only `8/31-11/16` or `September 11 (Fri)`. Never trust the year the segment step emits — cross-check the printed weekday against the candidate year (`8/31` and `11/16` are Mondays in 2026, matching the slide's `매주 월`; `9/11` and `9/18` are Fridays, matching its printed `(Fri)`). Weekdays are a strong, cheap year check, and they falsify a wrong year immediately.
