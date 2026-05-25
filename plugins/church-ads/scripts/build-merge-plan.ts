#!/usr/bin/env bun
/**
 * Build MERGE_PLAN.md for a Sunday's ads.
 *
 * For each ad in segments.json, finds existing Sanity events with similar
 * titles or slugs and emits an editable plan. The user picks an action per
 * ad (merge/new/skip) and the value, then the apply step (apply-plan.ts)
 * executes it.
 *
 * Usage:
 *   bun run build-merge-plan.ts --out <YYYYMMDD.church-ads dir>
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
  category_key: string;
}

interface ExistingEvent {
  _id: string;
  title?: { en?: string; ko?: string };
  date?: string;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const aa = a.toLowerCase().trim();
  const bb = b.toLowerCase().trim();
  if (aa === bb) return 1;
  const dist = levenshtein(aa, bb);
  const maxLen = Math.max(aa.length, bb.length);
  return 1 - dist / maxLen;
}

function findCandidates(ad: Ad, existing: ExistingEvent[]): { event: ExistingEvent; score: number }[] {
  const scores = existing.map((evt) => {
    const titleSim = similarity(ad.title.en, evt.title?.en || '');
    const idLooksLike = evt._id.toLowerCase().includes(ad.slug.toLowerCase()) ? 0.3 : 0;
    return { event: evt, score: Math.max(titleSim, idLooksLike) };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores.filter((s) => s.score >= 0.4).slice(0, 3);
}

async function main() {
  loadEnv(join(homedir(), '.config', '.env.d'));

  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  if (outIdx < 0) throw new Error('Missing --out');
  const outDir = resolve(args[outIdx + 1]);

  // Load Sanity creds from project's studio/.env (for project-specific auth)
  const studioEnv = resolve(__dirname, '..', '..', '..', '..', '..', '..', 'lab', 'church', 'ccs-events-seattle-clone', 'studio', '.env');
  if (existsSync(studioEnv)) loadEnv(studioEnv);

  // Fall back: caller provides STUDIO_ENV path
  const altIdx = args.indexOf('--studio-env');
  if (altIdx >= 0) loadEnv(resolve(args[altIdx + 1]));

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

  console.log(`Fetching existing events from Sanity...`);
  const existing = (await client.fetch(
    `*[_type == "event"] { _id, title, date }`,
  )) as ExistingEvent[];
  console.log(`  Found ${existing.length} existing events.`);

  const lines: string[] = [];
  lines.push('# Merge Plan');
  lines.push('');
  lines.push('Edit each ad block below to choose its action, then run:');
  lines.push('');
  lines.push('```bash');
  lines.push('bun run apply-plan.ts --out <this dir>');
  lines.push('```');
  lines.push('');
  lines.push('## Actions');
  lines.push('');
  lines.push('Per ad, set `action:` to ONE of:');
  lines.push('- `new` — create a new event document');
  lines.push('- `merge: <existing-event-id>` — overwrite that existing event with this ad');
  lines.push('- `skip` — do not push this ad');
  lines.push('');
  lines.push('Set `featured: true|false` and `primary: true|false` per ad.');
  lines.push('Set `publish_end_date: YYYY-MM-DD` (or leave empty) to auto-unpublish.');
  lines.push('Set `extra_images:` to a comma-separated list of image filenames in this dir to add multi-image support.');
  lines.push('');

  for (const ad of ads) {
    const candidates = findCandidates(ad, existing);
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${String(ad.index).padStart(2, '0')} — ${ad.title.en} / ${ad.title.ko}`);
    lines.push('');
    lines.push(`Slug: \`${ad.slug}\``);
    lines.push(`Date: ${ad.date}`);
    lines.push(`Category: ${ad.category_key}`);
    lines.push('');
    if (candidates.length > 0) {
      lines.push('### Candidates from existing Sanity events');
      lines.push('');
      for (const c of candidates) {
        const score = (c.score * 100).toFixed(0);
        lines.push(`- **${score}%** \`${c.event._id}\` — ${c.event.title?.en || '(untitled)'} (${c.event.date || 'no date'})`);
      }
      lines.push('');
    } else {
      lines.push('_No similar existing events found._');
      lines.push('');
    }
    const defaultAction = candidates.length > 0 && candidates[0].score > 0.7
      ? `merge: ${candidates[0].event._id}`
      : 'new';
    lines.push('```yaml');
    lines.push(`ad_index: ${ad.index}`);
    lines.push(`slug: ${ad.slug}`);
    lines.push(`action: ${defaultAction}`);
    lines.push(`featured: true`);
    lines.push(`primary: false`);
    lines.push(`publish_end_date:`);
    lines.push(`extra_images:`);
    lines.push('```');
    lines.push('');
  }

  const planPath = join(outDir, 'MERGE_PLAN.md');
  writeFileSync(planPath, lines.join('\n'));
  console.log(`\nWrote ${planPath}`);
  console.log('Edit it, then run apply-plan.ts.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
