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
  title: { en: string; ko: string };
  date: string;
  time: string;
  location: { en: string; ko: string };
  description: { en: string; ko: string };
  full_description: { en: string; ko: string };
  links: { label: string; url: string }[];
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
      category: { _type: 'reference', _ref: `category-${ad.category_key}` },
      description: ad.description,
      fullDescription: ad.full_description,
      images,
      featured: entry.featured,
      primary: entry.primary,
      links: ad.links.map((l, i) => ({
        _type: 'object',
        _key: `link-${i}`,
        label: l.label,
        url: l.url,
      })),
    };
    if (entry.publish_end_date) doc.publishEndDate = entry.publish_end_date;

    if (entry.action === 'new') {
      const id = `event-${ad.slug}`;
      const created = { ...doc, _id: id, _type: 'event' as const } as Parameters<typeof client.createOrReplace>[0];
      await client.createOrReplace(created);
      console.log(`  -> createOrReplace ${id}`);
    } else {
      const targetId = entry.action.merge;
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
