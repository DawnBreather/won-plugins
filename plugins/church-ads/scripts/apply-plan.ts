#!/usr/bin/env bun
/**
 * Apply MERGE_PLAN.md against Sanity.
 *
 * Reads YAML-ish blocks per ad, fetches matching segment data, uploads images
 * (regen-{slug}.{en,ko}.png plus any extras listed), and commits each event
 * via createOrReplace (new) or patch (merge).
 *
 * Hero exclusivity: clears `primary` on all other events before setting a new
 * one — same logic as the Studio publish action.
 *
 * Categories: `category` is the single primary (the badge on every card);
 * `alsoShowIn` is an optional list of extra categories that only widens which
 * filter chips list the event. Both write paths destroy the whole document, so
 * an existing `alsoShowIn` is read back and re-sent unless the ad names its own.
 *
 * Usage:
 *   bun run apply-plan.ts --out <YYYYMMDD.church-ads dir> --studio-env <path to studio/.env>
 */
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createClient, type SanityImageAssetDocument } from '@sanity/client';

function loadEnv(envPath: string): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

interface Ad {
  index: number;
  slug: string;
  category_key: string;
  // Extra categories this ad should ALSO appear under in the site's filter chips.
  // snake_case like every other key here: a camelCase `alsoShowIn` in segments.json
  // would sit next to this one, never be read, and the omission would look
  // deliberate (three events shipped 2020 dates that way on 2026-08-09).
  also_show_in?: string[];
  title: { en: string; ko: string };
  date: string;
  time: string;
  location: { en: string; ko: string };
  description: { en: string; ko: string };
  full_description: { en: string; ko: string };
  links: { label: string; url: string; end_date?: string }[];
  // Optional schedule metadata (present on ads processed after 2026-07-20).
  schedule_kind?: 'once' | 'recurring' | 'ongoing';
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  rec_freq?: 'weekly' | 'biweekly' | 'monthly' | 'none';
  rec_weekday?: number;
}

type CategoryRef = { _type: 'reference'; _ref: string };
type KeyedCategoryRef = CategoryRef & { _key: string };

/**
 * A reference to the category document, by its REAL `_id`.
 *
 * The six seeded documents happen to be `category-<key>` because
 * studio/migrate-categories.mjs set those ids explicitly; nothing in the schema
 * pins them. A category added through Studio gets a random uuid, so deriving
 * `category-${key}` from a valid key produces a dangling reference that passes
 * every key check and then resolves to a null ENTRY in `alsoShowIn[]->` -- a
 * missing chip, not an error. Resolve, never derive.
 */
function categoryRef(key: string, idByKey: Map<string, string>): CategoryRef {
  const id = idByKey.get(key);
  if (!id) throw new Error(`No category document for key "${key}" (resolve step should have caught this)`);
  return { _type: 'reference', _ref: id };
}

/**
 * `alsoShowIn` refs for an ad, or null when the ad says nothing about extras.
 *
 * The primary `category` is the badge every card shows; `alsoShowIn` only widens
 * which filter chips list the event. There is NO hierarchy: `general` does not
 * imply `adult`/`college`, so nothing is added here by implication — a chip lists
 * exactly the events tagged with that chip.
 *
 * Dedupes and drops the primary. GROQ does not dedupe, so a repeated key really
 * does come back twice; the site's mergeCategories collapses that, so nothing
 * breaks visibly -- but the duplicate then trips Studio's `unique()` rule, showing
 * a pastor a red error on a field they never touched.
 */
function alsoShowInRefs(ad: Ad, idByKey: Map<string, string>): KeyedCategoryRef[] | null {
  // Absent OR empty means "the slide said nothing about extra audiences", not
  // "delete what the pastor curated in Studio" — Gemini emits [] freely for an
  // optional array, and treating that as an instruction would wipe curation on
  // every re-announcement. Clearing extras is a Studio edit, not a pipeline one.
  if (!Array.isArray(ad.also_show_in) || ad.also_show_in.length === 0) return null;
  const seen = new Set<string>([ad.category_key]);
  const out: KeyedCategoryRef[] = [];
  for (const key of ad.also_show_in) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...categoryRef(key, idByKey), _key: `also-${key}` });
  }
  return out.length ? out : null;
}

/**
 * Resolve every category key an ad needs to a real document `_id`, failing before
 * the first write if any key has no document behind it.
 *
 * The Sanity API validates nothing, so a typo'd key is accepted and stored as a
 * dangling `_ref`; `alsoShowIn[]->` then resolves it to a null ENTRY inside the
 * array, which reads as a missing chip rather than as an error. Queried live
 * instead of hardcoded so a seventh category does not break the push, and the ids
 * come from the same query so they cannot be guessed wrong.
 */
async function resolveCategoryIds(
  client: ReturnType<typeof createClient>,
  ads: Ad[],
): Promise<Map<string, string>> {
  const rows = await client.fetch<{ key: string; id: string }[]>(
    `*[_type == "category"]{ key, "id": _id }`,
  );
  const idByKey = new Map(rows.map((r) => [r.key, r.id]));
  const valid = new Set(idByKey.keys());
  const bad: string[] = [];
  for (const ad of ads) {
    if (!valid.has(ad.category_key)) bad.push(`ad ${ad.index} (${ad.slug}): category_key "${ad.category_key}"`);
    for (const key of ad.also_show_in ?? []) {
      if (!valid.has(key)) bad.push(`ad ${ad.index} (${ad.slug}): also_show_in "${key}"`);
    }
  }
  if (bad.length) {
    throw new Error(
      `Unknown category key(s) — would become a dangling reference:\n  ${bad.join('\n  ')}\n` +
        `Valid keys: ${[...valid].sort().join(', ')}`,
    );
  }
  return idByKey;
}

/**
 * The `alsoShowIn` already on the target document, so a re-announcement cannot
 * drop it. `createOrReplace` REPLACES the whole document, and the merge path is a
 * full `.set()` overwrite (the one that nearly wiped the Parking Team's leader
 * phone numbers), so extras a pastor curated in Studio have to be read back and
 * re-sent explicitly.
 *
 * Reads the PUBLISHED document, which is also what both write paths target. An
 * unpublished draft keeps its own copy of the field and shadows this on publish.
 */
async function existingAlsoShowIn(
  client: ReturnType<typeof createClient>,
  id: string,
): Promise<KeyedCategoryRef[] | null> {
  const rows = await client.fetch<KeyedCategoryRef[] | null>(
    `*[_id == $id][0].alsoShowIn`,
    { id },
  );
  return Array.isArray(rows) && rows.length ? rows : null;
}

// Build the Sanity `schedule.*` fields from an ad's derived schedule metadata.
// Returns partial doc fields to merge; empty object if the ad has no schedule data.
function scheduleFields(ad: Ad): Record<string, unknown> {
  if (!ad.schedule_kind) return {};
  const out: Record<string, unknown> = { scheduleKind: ad.schedule_kind };
  if (ad.schedule_kind === 'once') {
    if (ad.start_date) out.startDate = ad.start_date;
    if (ad.end_date || ad.start_date) out.endDate = ad.end_date || ad.start_date;
    if (ad.start_time) out.startTime = ad.start_time;
    if (ad.end_time) out.endTime = ad.end_time;
  } else if (ad.schedule_kind === 'recurring' && ad.rec_freq && ad.rec_freq !== 'none') {
    const rec: Record<string, unknown> = { freq: ad.rec_freq };
    if (typeof ad.rec_weekday === 'number' && ad.rec_weekday >= 0) rec.weekday = ad.rec_weekday;
    out.recurrence = rec;
    if (ad.start_time) out.startTime = ad.start_time;
    if (ad.end_time) out.endTime = ad.end_time;
  }
  // 'ongoing' -> just scheduleKind
  return out;
}

interface PlanEntry {
  ad_index: number;
  slug: string;
  action: 'new' | { merge: string } | 'skip';
  featured: boolean;
  primary: boolean;
  publish_end_date: string | null;
  extra_images: string[];
}

function parsePlan(md: string): PlanEntry[] {
  const blocks = md.split(/```yaml\n/).slice(1);
  return blocks.map((b) => {
    const yaml = b.split('```')[0];
    const obj: Record<string, string> = {};
    for (const line of yaml.split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) obj[m[1]] = m[2].trim();
    }
    let action: PlanEntry['action'];
    const raw = obj.action || 'new';
    if (raw === 'new') action = 'new';
    else if (raw === 'skip') action = 'skip';
    else if (raw.startsWith('merge:')) action = { merge: raw.slice(6).trim() };
    else throw new Error(`Invalid action: ${raw}`);
    return {
      ad_index: parseInt(obj.ad_index, 10),
      slug: obj.slug,
      action,
      featured: (obj.featured || 'true') === 'true',
      primary: (obj.primary || 'false') === 'true',
      publish_end_date: obj.publish_end_date && obj.publish_end_date !== '' ? obj.publish_end_date : null,
      extra_images: (obj.extra_images || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  });
}

async function uploadImage(
  client: ReturnType<typeof createClient>,
  filePath: string,
): Promise<{ _type: 'image'; asset: { _type: 'reference'; _ref: string } } | null> {
  if (!existsSync(filePath)) return null;
  console.log(`    upload ${filePath}`);
  const asset = (await client.assets.upload('image', createReadStream(filePath), {
    filename: filePath.split('/').pop()!,
    contentType: 'image/png',
  })) as SanityImageAssetDocument;
  return { _type: 'image', asset: { _type: 'reference', _ref: asset._id } };
}

async function main() {
  loadEnv(join(homedir(), '.config', '.env.d'));

  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  if (outIdx < 0) throw new Error('Missing --out');
  const outDir = resolve(args[outIdx + 1]);

  const seIdx = args.indexOf('--studio-env');
  if (seIdx >= 0) loadEnv(resolve(args[seIdx + 1]));

  const projectId = process.env.SANITY_STUDIO_PROJECT_ID;
  const token = process.env.SANITY_AUTH_TOKEN;
  if (!projectId || !token) throw new Error('SANITY_STUDIO_PROJECT_ID / SANITY_AUTH_TOKEN not set');

  const client = createClient({
    projectId,
    dataset: 'production',
    apiVersion: '2025-01-01',
    token,
    useCdn: false,
  });

  const planPath = join(outDir, 'MERGE_PLAN.md');
  if (!existsSync(planPath)) throw new Error(`MERGE_PLAN.md not found at ${planPath}`);
  const plan = parsePlan(readFileSync(planPath, 'utf8'));

  const { ads } = JSON.parse(readFileSync(join(outDir, 'raw', 'segments.json'), 'utf8')) as {
    ads: Ad[];
  };
  const adByIndex = new Map(ads.map((a) => [a.index, a]));

  // Gate every key that is about to be written, before the first mutation — a
  // skipped ad's typo must not block the push, and a half-applied plan is worse
  // than a rejected one.
  const categoryIdByKey = await resolveCategoryIds(
    client,
    plan.filter((p) => p.action !== 'skip').flatMap((p) => adByIndex.get(p.ad_index) ?? []),
  );

  const newHero = plan.find((p) => p.primary && p.action !== 'skip');
  if (newHero) {
    console.log('Clearing primary=true on all other events (new hero incoming)...');
    const others = await client.fetch<string[]>(
      `*[_type == "event" && primary == true]._id`,
    );
    for (const id of others) {
      await client.patch(id).set({ primary: false }).commit();
      console.log(`  cleared on ${id}`);
    }
  }

  for (const entry of plan) {
    if (entry.action === 'skip') {
      console.log(`[${entry.ad_index}] ${entry.slug} — skipped`);
      continue;
    }
    const ad = adByIndex.get(entry.ad_index);
    if (!ad) {
      console.warn(`[${entry.ad_index}] ${entry.slug} — ad not found in segments.json, skipping`);
      continue;
    }

    console.log(`[${entry.ad_index}] ${entry.slug} — ${entry.action === 'new' ? 'new' : `merge ${entry.action.merge}`}`);

    const enImg = await uploadImage(client, join(outDir, `regen-${ad.slug}.en.png`));
    const koImg = await uploadImage(client, join(outDir, `regen-${ad.slug}.ko.png`));
    const baseImage = {
      _type: 'imagePair',
      _key: 'pair-0',
      ...(enImg ? { en: enImg } : {}),
      ...(koImg ? { ko: koImg } : {}),
    };
    const images: Record<string, unknown>[] = [];
    if (baseImage.en || baseImage.ko) images.push(baseImage);

    let extraIdx = 1;
    for (const filename of entry.extra_images) {
      const path = join(outDir, filename);
      const uploaded = await uploadImage(client, path);
      if (uploaded) {
        images.push({
          _type: 'imagePair',
          _key: `pair-${extraIdx}`,
          en: uploaded,
          ko: uploaded,
        });
        extraIdx++;
      }
    }

    const doc: Record<string, unknown> = {
      _type: 'event',
      title: ad.title,
      date: ad.date,
      time: ad.time,
      location: ad.location,
      category: categoryRef(ad.category_key, categoryIdByKey),
      description: ad.description,
      fullDescription: ad.full_description,
      images,
      featured: entry.featured,
      primary: entry.primary,
      // `endDate` makes a link retire on its own (a closed registration form
       // disappears while the announcement it belongs to stays live), so it must
       // survive the trip from segments.json into Sanity.
      links: ad.links.map((l, i) => ({
        _type: 'object',
        _key: `link-${i}`,
        label: l.label,
        url: l.url,
        ...(l.end_date ? { endDate: l.end_date } : {}),
      })),
    };
    if (entry.publish_end_date) doc.publishEndDate = entry.publish_end_date;
    Object.assign(doc, scheduleFields(ad));

    const targetId = entry.action === 'new' ? `event-${ad.slug}` : entry.action.merge;

    // Extras are a UNION of what is already on the target and what the ad names.
    // Not "the ad wins": a slide that mentions one audience is not an instruction
    // to delete the others, and both write paths here replace the whole field
    // (createOrReplace replaces the document; the merge path is a full .set()).
    // Taking the ad's list verbatim meant a slide saying "college students
    // welcome" silently dropped the Adult and General chips a pastor had set --
    // the Parking Team phone-number failure shape again. Removing an extra is a
    // Studio edit, deliberately not something a weekly slide can do.
    const fromAd = alsoShowInRefs(ad, categoryIdByKey);
    const existing = await existingAlsoShowIn(client, targetId);
    const primaryId = categoryIdByKey.get(ad.category_key);
    const byRef = new Map<string, KeyedCategoryRef>();
    for (const ref of [...(existing ?? []), ...(fromAd ?? [])]) {
      // Drop anything that repeats the primary: it is already the badge, and the
      // duplicate would only surface as a red unique() error in Studio.
      if (!ref?._ref || ref._ref === primaryId) continue;
      if (!byRef.has(ref._ref)) byRef.set(ref._ref, ref);
    }
    const alsoShowIn = [...byRef.values()];
    if (alsoShowIn.length) {
      doc.alsoShowIn = alsoShowIn;
      const keyById = new Map([...categoryIdByKey].map(([k, v]) => [v, k]));
      const keys = alsoShowIn.map((r) => keyById.get(r._ref) ?? r._ref).join(', ');
      const added = (fromAd ?? []).filter((r) => !(existing ?? []).some((e) => e._ref === r._ref)).length;
      const kept = alsoShowIn.length - added;
      console.log(`    alsoShowIn: ${keys}  (${kept} kept, ${added} added by this ad)`);
    } else if (existing?.length) {
      // Unreachable unless every existing extra equalled the primary; log it so a
      // field going empty is never silent.
      console.log('    alsoShowIn: cleared (every existing extra repeated the primary)');
    }

    if (entry.action === 'new') {
      const created = { ...doc, _id: targetId, _type: 'event' as const } as Parameters<typeof client.createOrReplace>[0];
      await client.createOrReplace(created);
      console.log(`  -> createOrReplace ${targetId}`);
    } else {
      // Don't patch _type
      const { _type, ...patch } = doc as { _type?: string };
      void _type;
      await client.patch(targetId).set(patch).commit();
      console.log(`  -> patched ${targetId}`);
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
