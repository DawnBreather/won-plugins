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
