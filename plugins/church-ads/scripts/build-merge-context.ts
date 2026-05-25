#!/usr/bin/env bun
/**
 * Build MERGE_CONTEXT.md — a rich data dump of all existing Sanity events
 * and all new ads from segments.json. Intended to be read by an LLM (the
 * Claude Code session running the push-to-sanity skill), which then writes
 * MERGE_PLAN.md with reasoned merge decisions per ad.
 *
 * No algorithmic matching here. Decision-making is delegated to the LLM.
 *
 * Usage:
 *   bun run build-merge-context.ts --out <YYYYMMDD.church-ads dir> --studio-env <studio/.env>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createClient } from '@sanity/client';

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
  title: { en: string; ko: string };
  date: string;
  time: string;
  location: { en: string; ko: string };
  description: { en: string; ko: string };
  full_description: { en: string; ko: string };
  category_key: string;
  transcript_chunk: string;
}

interface ExistingEvent {
  _id: string;
  title?: { en?: string; ko?: string };
  date?: string;
  time?: string;
  location?: { en?: string; ko?: string };
  description?: { en?: string; ko?: string };
  fullDescription?: { en?: string; ko?: string };
  category?: { key?: string };
  featured?: boolean;
  primary?: boolean;
  publishEndDate?: string;
}

function eventBlock(evt: ExistingEvent): string {
  const lines: string[] = [];
  lines.push(`### \`${evt._id}\``);
  lines.push('');
  lines.push(`- **Title (EN):** ${evt.title?.en || '_(none)_'}`);
  lines.push(`- **Title (KO):** ${evt.title?.ko || '_(none)_'}`);
  lines.push(`- **Date:** ${evt.date || '_(none)_'}`);
  lines.push(`- **Time:** ${evt.time || '_(none)_'}`);
  lines.push(`- **Location:** EN: ${evt.location?.en || '_(none)_'} / KO: ${evt.location?.ko || '_(none)_'}`);
  lines.push(`- **Category:** ${evt.category?.key || '_(none)_'}`);
  const flags: string[] = [];
  if (evt.featured) flags.push('featured');
  if (evt.primary) flags.push('HERO');
  if (evt.publishEndDate) flags.push(`ends ${evt.publishEndDate}`);
  if (flags.length) lines.push(`- **Flags:** ${flags.join(', ')}`);
  if (evt.description?.en) {
    lines.push(`- **Description (EN):** ${evt.description.en}`);
  }
  if (evt.fullDescription?.en) {
    lines.push('');
    lines.push(`<details><summary>Full description (EN)</summary>`);
    lines.push('');
    lines.push(evt.fullDescription.en);
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}

function adBlock(ad: Ad): string {
  const lines: string[] = [];
  lines.push(`### Ad ${String(ad.index).padStart(2, '0')} — \`${ad.slug}\``);
  lines.push('');
  lines.push(`- **Title (EN):** ${ad.title.en}`);
  lines.push(`- **Title (KO):** ${ad.title.ko}`);
  lines.push(`- **Date:** ${ad.date}`);
  lines.push(`- **Time:** ${ad.time}`);
  lines.push(`- **Location:** EN: ${ad.location.en} / KO: ${ad.location.ko}`);
  lines.push(`- **Category:** ${ad.category_key}`);
  lines.push(`- **Description (EN):** ${ad.description.en}`);
  lines.push('');
  lines.push(`<details><summary>Full description (EN)</summary>`);
  lines.push('');
  lines.push(ad.full_description.en);
  lines.push('');
  lines.push('</details>');
  if (ad.transcript_chunk?.trim()) {
    lines.push('');
    lines.push(`<details><summary>Voice transcript chunk</summary>`);
    lines.push('');
    lines.push('> ' + ad.transcript_chunk.replace(/\n/g, '\n> '));
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
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
  if (!projectId || !token) {
    throw new Error('SANITY_STUDIO_PROJECT_ID / SANITY_AUTH_TOKEN not set. Pass --studio-env <path>.');
  }

  const client = createClient({
    projectId,
    dataset: 'production',
    apiVersion: '2025-01-01',
    token,
    useCdn: false,
  });

  const segPath = join(outDir, 'raw', 'segments.json');
  const { ads } = JSON.parse(readFileSync(segPath, 'utf8')) as { ads: Ad[] };

  console.log(`Fetching all events from Sanity...`);
  const existing = (await client.fetch(`*[_type == "event"] | order(_id) {
    _id, title, date, time, location, description, fullDescription,
    "category": category->{ "key": key },
    featured, primary, publishEndDate
  }`)) as ExistingEvent[];
  console.log(`  ${existing.length} existing events`);
  console.log(`  ${ads.length} new ads`);

  const lines: string[] = [];
  lines.push('# Merge Context');
  lines.push('');
  lines.push('Full data dump for decision-making. The LLM running the push-to-sanity skill should read this, then write `MERGE_PLAN.md` with merge decisions per ad.');
  lines.push('');
  lines.push(`- Existing Sanity events: ${existing.length}`);
  lines.push(`- New ads to push: ${ads.length}`);
  lines.push('');
  lines.push('## Decision Heuristics');
  lines.push('');
  lines.push('For each new ad, decide one of:');
  lines.push('- `new` — distinct event not represented in existing set');
  lines.push('- `merge: <_id>` — refresh of existing recurring/series event');
  lines.push('- `skip` — duplicate of another ad in this batch, or not worth publishing');
  lines.push('');
  lines.push('Consider:');
  lines.push('- **Recurring events** (weekly prayer, monthly devotional) — same event, slide just changes per week. Merge.');
  lines.push('- **Series with instance number** ("22nd Happy Couple School") — same event document, update content. Merge.');
  lines.push('  - But "23rd Happy Couple School" next year would be `new` since the prior cohort has concluded.');
  lines.push('- **Past events** in existing data — if existing event\'s date is past and new ad is for a future similar topic, lean toward `merge` (refresh the document) only if the same series/cadence; otherwise `new`.');
  lines.push('- **Different scope** (e.g. golf tournament vs men\'s general gathering) — separate events even if related ministry.');
  lines.push('- **Same topic, different date** without recurring pattern — usually `new`.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Existing Events');
  lines.push('');
  for (const evt of existing) {
    lines.push(eventBlock(evt));
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('## New Ads');
  lines.push('');
  for (const ad of ads) {
    lines.push(adBlock(ad));
    lines.push('');
  }

  const ctxPath = join(outDir, 'MERGE_CONTEXT.md');
  writeFileSync(ctxPath, lines.join('\n'));
  console.log(`\nWrote ${ctxPath}`);
  console.log('Next: read this, decide per ad, write MERGE_PLAN.md, then run apply-plan.ts.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
