---
name: push-to-sanity
description: Use when per-ad markdown files exist in `.church-ads.raw/YYYYMMDD.church-ads/` (output of /church-ads:process-ads) and the user wants to push them as event documents to the CCS Seattle Sanity CMS. Triggers on "push ads to Sanity", "publish today's announcements", "push to CMS", or `/church-ads:push-to-sanity`. Destructive — uses createOrReplace and unsets `primary` on existing hero events.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

# Push Ads to Sanity

Convert per-ad markdown files (output of `/church-ads:process-ads`) into Sanity event documents.

## When to Use

After `/church-ads:process-ads` produced `{NN}-{slug}.md` files and the user has reviewed them. Run this to push to the live CMS — it triggers a Cloudflare Pages rebuild via Sanity webhook.

## Prerequisites

| Item | Where |
|------|-------|
| Per-ad MDs | `.church-ads.raw/YYYYMMDD.church-ads/{NN}-{slug}.md` |
| Regen images | `.church-ads.raw/YYYYMMDD.church-ads/regen-{slug}.png` |
| Sanity creds | `studio/.env` (`SANITY_STUDIO_PROJECT_ID`, `SANITY_AUTH_TOKEN`) |
| Project | `/Users/temporary/lab/church/ccs-events-seattle-clone` |

## Confirm before push

Always ask:

1. Which ads should be `featured: true`?
2. Which single ad (if any) should be the new `primary` (hero)? Default = none, keep current hero.
3. Confirm date / time / location strings match what's in the MDs.

## Pipeline

### 1. Parse MDs -> JSON spec

Read each `{NN}-{slug}.md`. Extract YAML-like front block + bilingual fields. Resolve to:

```ts
{
  _id: `event-${slug}`,
  imageFile: `regen-${slug}.png`,
  categoryKey: 'general' | 'specialEvents' | ...,
  title: { en, ko },
  date: '...',
  time: '...',
  location: { en, ko },
  description: { en, ko },
  fullDescription: { en, ko },
  links: [{ label, url }],
  featured: boolean,
  primary: boolean,
}
```

### 2. Generate migration script

Write to `studio/add-${MMDD}-events.mjs` following `studio/add-feb22-events.mjs` pattern. Include:
- Hero unset step (clear current `primary` events)
- Image upload via `client.assets.upload`
- `createOrReplace` per event

Use the existing script as the template — do NOT diverge from its structure.

### 3. Run migration

```bash
cd /Users/temporary/lab/church/ccs-events-seattle-clone/studio
export $(cat .env | xargs)
node add-${MMDD}-events.mjs
```

### 4. Verify

```bash
node -e "
import('@sanity/client').then(({createClient}) => {
  const c = createClient({projectId:process.env.SANITY_STUDIO_PROJECT_ID, dataset:'production', apiVersion:'2025-01-01', useCdn:false, token:process.env.SANITY_AUTH_TOKEN});
  c.fetch('*[_type==\"event\" && _id in \$ids]{_id,title,featured,primary}', {ids: [...]}).then(console.log);
})
"
```

Report which docs were created and which is the new hero.

### 5. Webhook -> rebuild

Sanity webhook auto-fires Cloudflare Pages deploy hook (~1-2 min rebuild). User does not need to deploy manually. Report the live URL: `https://ccs-events-seattle.pages.dev`.

## Categories

Map ad MD `category:` field to Sanity category document `_ref`:

| Key | Korean | Sanity ref |
|-----|--------|-----------|
| `college` | 대학부 | `category-college` |
| `youngAdult` | 청년부 | `category-youngAdult` |
| `adult` | 장년부 | `category-adult` |
| `newcomer` | 새가족 | `category-newcomer` |
| `specialEvents` | 특별 행사 | `category-specialEvents` |
| `general` | 전체 | `category-general` |

## Gotchas

- **`createOrReplace` is destructive** — overwrites existing event with same `_id`. Use stable slug-based `_id`s; ask user before overwriting same-day re-runs.
- **Hero exclusivity is enforced** by Studio publish action AND by the migration script. Migration script unsets `primary` on all other events first, then sets new hero.
- **Korean text must use church terminology** (예배, 말씀, 교제, 묵상). Don't ship machine translations without review.
- **Image upload is one-shot** — no idempotency. Re-running creates duplicate assets. Check `regen-{slug}.png` mtime to skip unchanged.
- **Webhook -> rebuild ~1-2 min** — user may not see changes immediately. Don't claim "live" until they confirm.
- **Bilingual fields all required** — Sanity schema validates both `en` and `ko`. Empty strings fail.
- **Absolute paths** in script — `import.meta.dirname` resolves relative to `studio/`. Image paths must be `..` -> `.church-ads.raw/...`.
