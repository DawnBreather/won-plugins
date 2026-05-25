#!/usr/bin/env bun
/**
 * Regenerate clean bilingual slide images for each ad in segments.json
 * using Gemini 2.5 Flash Image (Nano Banana).
 *
 * Usage:
 *   bun run regen-images.ts --out <YYYYMMDD.church-ads dir>
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
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

interface Ad {
  index: number;
  slug: string;
  page_indices: number[];
  regen_prompt: { en: string; ko: string };
}

const MODEL = 'gemini-3.1-flash-image-preview';

async function readAsBase64(path: string) {
  const buf = await readFile(path);
  return { mimeType: 'image/png', data: buf.toString('base64') };
}

async function regenerate(
  ai: GoogleGenAI,
  primaryPath: string,
  refPaths: string[],
  prompt: string,
): Promise<Buffer> {
  const parts: any[] = [{ text: prompt }, { inlineData: await readAsBase64(primaryPath) }];
  for (const r of refPaths) parts.push({ inlineData: await readAsBase64(r) });

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: parts,
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '16:9' },
    },
  });

  const candidate = res.candidates?.[0];
  const respParts = candidate?.content?.parts || [];
  for (const p of respParts) {
    if (p.inlineData?.data) {
      return Buffer.from(p.inlineData.data, 'base64');
    }
  }
  const text = respParts.map((p) => p.text).filter(Boolean).join('\n');
  throw new Error(`No image returned. Text: ${text || '(none)'}`);
}

async function main() {
  loadEnvD();
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  if (outIdx < 0) throw new Error('Missing --out');
  const outDir = resolve(args[outIdx + 1]);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const segPath = join(outDir, 'raw', 'segments.json');
  const { ads } = JSON.parse(readFileSync(segPath, 'utf8')) as { ads: Ad[] };
  console.log(`Regenerating ${ads.length} images...`);

  const ai = new GoogleGenAI({ apiKey });
  await mkdir(outDir, { recursive: true });

  const langs: ('en' | 'ko')[] = ['en', 'ko'];

  for (const ad of ads) {
    const pageFile = (n: number) => join(outDir, 'raw', `page-${String(n).padStart(2, '0')}.png`);
    const primary = pageFile(ad.page_indices[0]);
    const refs = ad.page_indices.slice(1).map(pageFile);
    for (const lang of langs) {
      const out = join(outDir, `regen-${ad.slug}.${lang}.png`);
      const prompt = strictPrompt(ad.regen_prompt[lang], lang);
      process.stdout.write(`  [${ad.index}/${ads.length}] ${ad.slug} (${lang})... `);
      try {
        const buf = await regenerate(ai, primary, refs, prompt);
        await writeFile(out, buf);
        console.log(`OK (${(buf.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        console.log(`FAIL: ${(err as Error).message}`);
      }
    }
  }
  console.log('\nDone.');
}

function strictPrompt(base: string, lang: 'en' | 'ko'): string {
  const langName = lang === 'en' ? 'English' : 'Korean (한국어)';
  const otherName = lang === 'en' ? 'Korean' : 'English';
  return `Render a church announcement slide with text EXCLUSIVELY in ${langName}. CRITICAL: Do NOT include any ${otherName} text — every word, label, heading, and body line must be in ${langName} only.

${base}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
