#!/usr/bin/env bun
/**
 * One-shot migration: convert old segments.json with `regen_prompt: string`
 * to new format with `regen_prompt: { en, ko }`.
 *
 * Uses Gemini to localize each existing prompt (cheaper than re-running
 * the full pipeline).
 *
 * Usage:
 *   bun run upgrade-prompts.ts --segments <segments.json path>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { GoogleGenAI } from '@google/genai';

function loadEnvD(): void {
  const envFile = join(homedir(), '.config', '.env.d');
  if (!existsSync(envFile)) return;
  const raw = readFileSync(envFile, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadEnvD();
  const args = process.argv.slice(2);
  const idx = args.indexOf('--segments');
  if (idx < 0) throw new Error('Missing --segments');
  const segPath = resolve(args[idx + 1]);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const ai = new GoogleGenAI({ apiKey });

  const data = JSON.parse(readFileSync(segPath, 'utf8'));
  const ads = data.ads as any[];

  console.log(`Upgrading ${ads.length} ads...`);
  for (const ad of ads) {
    if (typeof ad.regen_prompt !== 'string') {
      console.log(`  [${ad.index}] ${ad.slug}: already bilingual, skipping`);
      continue;
    }
    process.stdout.write(`  [${ad.index}] ${ad.slug}... `);
    const res = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Given this image-generation prompt for a church slide, produce TWO versions:
- "en": same prompt but rewritten so the resulting slide will be ENGLISH-ONLY (every label, header, and body line in English only — no Korean)
- "ko": same prompt rewritten so the slide will be KOREAN-ONLY (모두 한국어 — no English; use church-appropriate Korean)
Visual style/layout should match between versions. Preserve ALL factual info exactly (dates, times, locations, fees, names, contact numbers).
Output JSON: { "en": "...", "ko": "..." }

Original prompt:
${ad.regen_prompt}

Bilingual ad info for context:
- Title EN: ${ad.title.en}
- Title KO: ${ad.title.ko}
- Description EN: ${ad.description.en}
- Description KO: ${ad.description.ko}
- Date: ${ad.date}
- Time: ${ad.time}
- Location EN: ${ad.location.en}
- Location KO: ${ad.location.ko}`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            en: { type: 'string' },
            ko: { type: 'string' },
          },
          required: ['en', 'ko'],
        },
      },
    });
    const text = res.text;
    if (!text) throw new Error('Empty response');
    const parsed = JSON.parse(text) as { en: string; ko: string };
    ad.regen_prompt = parsed;
    console.log('OK');
  }

  writeFileSync(segPath, JSON.stringify(data, null, 2));
  console.log(`\nWrote ${segPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
