#!/usr/bin/env bun
/**
 * Church-ad pipeline: PDF + Voice Memo -> per-ad bilingual MDs.
 *
 * Phases:
 *   0. Extract PDF pages via pdftoppm -> raw/page-N.png
 *   1. Transcribe voice memo via OpenAI gpt-4o-transcribe -> raw/transcript.md
 *   2. Segment + translate via Gemini 3.5 Flash -> raw/segments.json
 *   3. Write per-ad MD files. (Image regen happens in Claude session via nano-banana MCP.)
 *
 * Usage:
 *   bun run process-ads.ts --date 20260524 --pdf <path> --voice <path> --out <dir>
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

// ------------- env -------------

function loadEnvD(): void {
  const envFile = join(homedir(), '.config', '.env.d');
  if (!existsSync(envFile)) return;
  const raw = readFileSync(envFile, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ------------- args -------------

interface Args {
  date: string;
  pdf: string;
  voice: string;
  out: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(`--${k}`);
    if (i < 0 || i === a.length - 1) throw new Error(`Missing --${k}`);
    return a[i + 1];
  };
  return { date: get('date'), pdf: get('pdf'), voice: get('voice'), out: get('out') };
}

// ------------- phase 0: PDF -> PNG -------------

function extractPdfPages(pdf: string, rawDir: string): string[] {
  mkdirSync(rawDir, { recursive: true });
  const prefix = join(rawDir, 'page');
  const r = spawnSync('pdftoppm', ['-png', '-r', '200', pdf, prefix], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('pdftoppm failed');
  const pages = readdirSync(rawDir)
    .filter((f) => /^page-\d+\.png$/.test(f))
    .sort();
  for (const f of pages) {
    const m = f.match(/^page-(\d+)\.png$/);
    if (!m) continue;
    const padded = `page-${m[1].padStart(2, '0')}.png`;
    if (padded !== f) {
      renameSync(join(rawDir, f), join(rawDir, padded));
    }
  }
  return readdirSync(rawDir)
    .filter((f) => /^page-\d+\.png$/.test(f))
    .map((f) => join(rawDir, f))
    .sort();
}

// ------------- phase 1: voice -> transcript -------------

async function transcribe(voicePath: string, openai: OpenAI): Promise<string> {
  const file = Bun.file(voicePath);
  const res = await openai.audio.transcriptions.create({
    file: new File([await file.arrayBuffer()], basename(voicePath), { type: 'audio/m4a' }),
    model: 'gpt-4o-transcribe',
    response_format: 'text',
  });
  return typeof res === 'string' ? res : (res as any).text;
}

// ------------- phase 2: segment + translate -------------

interface AdSegment {
  index: number;
  slug: string;
  page_indices: number[];
  category_key: 'college' | 'youngAdult' | 'adult' | 'newcomer' | 'specialEvents' | 'general';
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
  // Machine-readable schedule (mirrors the Sanity `schedule` field group).
  schedule_kind: 'once' | 'recurring' | 'ongoing';
  start_date: string; // YYYY-MM-DD or '' (once only)
  end_date: string; // YYYY-MM-DD or '' (once only)
  start_time: string; // HH:MM 24h or ''
  end_time: string; // HH:MM 24h or ''
  rec_freq: 'weekly' | 'biweekly' | 'monthly' | 'none';
  rec_weekday: number; // 0=Sun..6=Sat, -1 if n/a
}

const SEGMENT_SCHEMA_PROMPT = `You are processing weekly Sunday announcements for Community Church of Seattle (CCS / 시애틀 형제교회), a Korean-American bilingual congregation.

Inputs:
- Slide images (one per page, 1-N) photographed during service
- Voice transcript of the announcement segment

Task:
- Identify each distinct ANNOUNCEMENT (one ad per slide normally; rarely one ad spans two slides)
- For each ad, output the JSON schema below
- All text fields MUST be bilingual: { en, ko }
- Use church-appropriate Korean (예배, 말씀, 교제, 묵상, 큐티, 헌금)
- Map to one of these categories: college, youngAdult, adult, newcomer, specialEvents, general
- Title slug: kebab-case, English, descriptive (e.g. "amazing-touch", "30-days-of-worship")
- "regen_prompt" is { en, ko } — TWO separate prompts for nano-banana image regen, one per language. Each describes a CLEAN church announcement slide IN THAT LANGUAGE ONLY (English-only OR Korean-only, never mixed). Preserve ALL factual info (dates, times, locations, fees, URLs). No glare, no skew. Photographic quality. 16:9. The visual layout/style should match between en and ko versions.
- "transcript_chunk" is verbatim from the transcript (the part of the audio related to this specific ad)
- "featured" defaults true for all (can be tuned later); "primary" defaults false (only one event can be hero, user picks later)
- SCHEDULE (for the site calendar) — classify each ad:
  - "schedule_kind": "once" (a specific date/range, e.g. "July 9-10"), "recurring" (repeats: "Every Sunday", "every other Tuesday", "Every Month"), or "ongoing" (no calendar slot: "Ongoing", "All Year Around", open sign-up).
  - For "once": set start_date (YYYY-MM-DD) and end_date (= start_date if single day). Times are Pacific; convert "7 PM" -> "19:00", "4:20-7:00 PM" -> start_time 16:20 end_time 19:00. If the year is not explicit, infer it from context (announcements are for the current/upcoming season).
  - For "recurring": set rec_freq (weekly/biweekly/monthly) and rec_weekday (Sun=0..Sat=6, -1 for monthly). Leave dates empty.
  - For "ongoing": leave dates/recurrence empty (rec_freq "none", rec_weekday -1).
  - Unused string fields = "" ; unused rec_freq = "none" ; unused rec_weekday = -1.

Output ONLY valid JSON: { "ads": [...] }`;

async function segmentWithGemini(
  pagePaths: string[],
  transcript: string,
  genai: GoogleGenAI,
): Promise<AdSegment[]> {
  const parts: any[] = [{ text: SEGMENT_SCHEMA_PROMPT }];
  for (const p of pagePaths) {
    const data = readFileSync(p);
    parts.push({
      inlineData: { mimeType: 'image/png', data: data.toString('base64') },
    });
  }
  parts.push({ text: `\nVoice transcript:\n${transcript}` });

  const res = await genai.models.generateContent({
    model: 'gemini-3.5-flash',
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          ads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                slug: { type: 'string' },
                page_indices: { type: 'array', items: { type: 'integer' } },
                category_key: { type: 'string' },
                title: bilingual(),
                date: { type: 'string' },
                time: { type: 'string' },
                location: bilingual(),
                description: bilingual(),
                full_description: bilingual(),
                links: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { label: { type: 'string' }, url: { type: 'string' } },
                    required: ['label', 'url'],
                  },
                },
                transcript_chunk: { type: 'string' },
                regen_prompt: bilingual(),
                featured: { type: 'boolean' },
                primary: { type: 'boolean' },
                schedule_kind: { type: 'string', enum: ['once', 'recurring', 'ongoing'] },
                start_date: { type: 'string' },
                end_date: { type: 'string' },
                start_time: { type: 'string' },
                end_time: { type: 'string' },
                rec_freq: { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'none'] },
                rec_weekday: { type: 'integer' },
              },
              required: [
                'index', 'slug', 'page_indices', 'category_key', 'title',
                'date', 'time', 'location', 'description', 'full_description',
                'links', 'transcript_chunk', 'regen_prompt', 'featured', 'primary',
                'schedule_kind', 'start_date', 'end_date', 'start_time', 'end_time',
                'rec_freq', 'rec_weekday',
              ],
            },
          },
        },
        required: ['ads'],
      },
    },
  });

  const text = res.text;
  if (!text) throw new Error('Gemini returned empty response');
  const parsed = JSON.parse(text) as { ads: AdSegment[] };
  return parsed.ads;
}

function bilingual() {
  return {
    type: 'object',
    properties: { en: { type: 'string' }, ko: { type: 'string' } },
    required: ['en', 'ko'],
  };
}

// ------------- phase 3: write MDs -------------

function formatSchedule(ad: AdSegment): string {
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (ad.schedule_kind === 'once') {
    const range = ad.end_date && ad.end_date !== ad.start_date ? `${ad.start_date} -> ${ad.end_date}` : ad.start_date;
    const t = ad.start_time ? ` @ ${ad.start_time}${ad.end_time ? `-${ad.end_time}` : ''}` : '';
    return `once · ${range || '?'}${t}`;
  }
  if (ad.schedule_kind === 'recurring') {
    const day = ad.rec_weekday >= 0 && ad.rec_weekday <= 6 ? ` ${wd[ad.rec_weekday]}` : '';
    const t = ad.start_time ? ` @ ${ad.start_time}` : '';
    return `recurring · ${ad.rec_freq}${day}${t}`;
  }
  return 'ongoing';
}

function writeAdMd(ad: AdSegment, outDir: string, pagePaths: string[]): string {
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

// ------------- main -------------

async function main(): Promise<void> {
  loadEnvD();

  const args = parseArgs();
  const outDir = resolve(args.out);
  const rawDir = join(outDir, 'raw');
  mkdirSync(rawDir, { recursive: true });

  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set (check ~/.config/.env.d)');
  if (!geminiKey) throw new Error('GEMINI_API_KEY not set (check ~/.config/.env.d)');

  console.log(`[0/3] Extracting PDF pages...`);
  const pagePaths = extractPdfPages(args.pdf, rawDir);
  console.log(`  -> ${pagePaths.length} pages`);

  console.log(`[1/3] Copying voice memo + transcribing...`);
  const voiceCopy = join(rawDir, 'voice.m4a');
  copyFileSync(args.voice, voiceCopy);
  const openai = new OpenAI({ apiKey: openaiKey });
  const transcript = await transcribe(voiceCopy, openai);
  const transcriptPath = join(rawDir, 'transcript.md');
  writeFileSync(transcriptPath, transcript);
  console.log(`  -> ${transcript.length} chars to ${transcriptPath}`);

  console.log(`[2/3] Segmenting + translating with Gemini...`);
  const genai = new GoogleGenAI({ apiKey: geminiKey });
  const ads = await segmentWithGemini(pagePaths, transcript, genai);
  const hasZeroIndex = ads.some((a) => a.page_indices.includes(0));
  if (hasZeroIndex) {
    for (const a of ads) a.page_indices = a.page_indices.map((i) => i + 1);
  }
  const segmentsPath = join(rawDir, 'segments.json');
  writeFileSync(segmentsPath, JSON.stringify({ ads }, null, 2));
  console.log(`  -> ${ads.length} ads to ${segmentsPath}`);

  console.log(`[3/3] Writing per-ad MDs...`);
  const written: string[] = [];
  for (const ad of ads) {
    const path = writeAdMd(ad, outDir, pagePaths);
    written.push(path);
    console.log(`  -> ${basename(path)}`);
  }

  console.log(`\nDone. ${ads.length} ads, ${pagePaths.length} pages.`);
  console.log(`Next: run nano-banana edit_image for each ad's regen_prompt to produce regen-{slug}.png.`);
  console.log(`\nSegments JSON: ${segmentsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
