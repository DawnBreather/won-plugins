#!/usr/bin/env bun
/**
 * Re-write per-ad MD files from segments.json (does not re-call APIs).
 * Useful after segments.json schema change.
 *
 * Usage:
 *   bun run rewrite-mds.ts --out <YYYYMMDD.church-ads dir>
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

interface Ad {
  index: number;
  slug: string;
  page_indices: number[];
  category_key: string;
  title: { en: string; ko: string };
  date: string;
  time: string;
  location: { en: string; ko: string };
  description: { en: string; ko: string };
  full_description: { en: string; ko: string };
  links: { label: string; url: string }[];
  transcript_chunk: string;
  regen_prompt: { en: string; ko: string };
  featured: boolean;
  primary: boolean;
  schedule_kind?: 'once' | 'recurring' | 'ongoing';
  start_date?: string;
  end_date?: string;
  start_time?: string;
  end_time?: string;
  rec_freq?: 'weekly' | 'biweekly' | 'monthly' | 'none';
  rec_weekday?: number;
}

function formatSchedule(ad: Ad): string {
  if (!ad.schedule_kind) return '(not set)';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (ad.schedule_kind === 'once') {
    const range = ad.end_date && ad.end_date !== ad.start_date ? `${ad.start_date} -> ${ad.end_date}` : ad.start_date;
    const t = ad.start_time ? ` @ ${ad.start_time}${ad.end_time ? `-${ad.end_time}` : ''}` : '';
    return `once · ${range || '?'}${t}`;
  }
  if (ad.schedule_kind === 'recurring') {
    const day = ad.rec_weekday !== undefined && ad.rec_weekday >= 0 && ad.rec_weekday <= 6 ? ` ${wd[ad.rec_weekday]}` : '';
    const t = ad.start_time ? ` @ ${ad.start_time}` : '';
    return `recurring · ${ad.rec_freq}${day}${t}`;
  }
  return 'ongoing';
}

function writeAdMd(ad: Ad, outDir: string, pagePaths: string[]): string {
  const num = String(ad.index).padStart(2, '0');
  const filename = `${num}-${ad.slug}.md`;
  const filepath = join(outDir, filename);
  const sourcePages = ad.page_indices
    .map((i) => `- Slide: [raw/${basename(pagePaths[i - 1])}](raw/${basename(pagePaths[i - 1])})`)
    .join('\n');
  const linksBlock = ad.links.length
    ? '\n## Links\n\n' + ad.links.map((l) => `- [${l.label}](${l.url})`).join('\n') + '\n'
    : '';

  const body = `# ${ad.title.en} / ${ad.title.ko}

EN: ![${ad.title.en}](regen-${ad.slug}.en.png)

KO: ![${ad.title.ko}](regen-${ad.slug}.ko.png)

- **Date:** ${ad.date}
- **Time:** ${ad.time}
- **Location:** EN: ${ad.location.en} / KO: ${ad.location.ko}
- **Category:** ${ad.category_key}
- **Schedule:** ${formatSchedule(ad)}
- **Featured:** ${ad.featured}
- **Primary (hero):** ${ad.primary}

## Description (EN)

${ad.description.en}

## 설명 (한국어)

${ad.description.ko}

## Full Description (EN)

${ad.full_description.en}

## 자세한 설명 (한국어)

${ad.full_description.ko}
${linksBlock}
## Source

${sourcePages}

Transcript chunk:

> ${ad.transcript_chunk.replace(/\n/g, '\n> ')}

## Regen Prompts (for nano-banana edit_image)

EN:
\`\`\`
${ad.regen_prompt.en}
\`\`\`

KO:
\`\`\`
${ad.regen_prompt.ko}
\`\`\`
`;

  writeFileSync(filepath, body);
  return filepath;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  if (outIdx < 0) throw new Error('Missing --out');
  const outDir = resolve(args[outIdx + 1]);

  const { ads } = JSON.parse(readFileSync(join(outDir, 'raw', 'segments.json'), 'utf8')) as {
    ads: Ad[];
  };

  const pagePaths = readdirSync(join(outDir, 'raw'))
    .filter((f) => /^page-\d+\.png$/.test(f))
    .map((f) => join(outDir, 'raw', f))
    .sort();

  // Remove old MDs
  for (const f of readdirSync(outDir)) {
    if (/^\d{2}-.*\.md$/.test(f)) unlinkSync(join(outDir, f));
  }

  console.log(`Writing ${ads.length} per-ad MDs...`);
  for (const ad of ads) {
    const path = writeAdMd(ad, outDir, pagePaths);
    console.log(`  -> ${basename(path)}`);
  }
}

main();
