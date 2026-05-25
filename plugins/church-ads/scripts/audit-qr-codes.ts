#!/usr/bin/env bun
/**
 * Audit all Sanity event images for QR codes.
 *
 * For each event:
 *   1. Download images[].en + images[].ko from Sanity CDN
 *   2. Decode QR codes via jsQR
 *   3. Cross-reference decoded URLs with links[]
 *
 * Report:
 *   - Merge candidates: groups of events sharing the same QR URL
 *   - Link backfill: events with QRs whose URL is not in links[]
 *
 * Usage:
 *   bun run audit-qr-codes.ts --studio-env <studio/.env> [--out <report.md>]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createClient } from '@sanity/client';
import sharp from 'sharp';
import jsQR from 'jsqr';

function loadEnv(envPath: string): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

interface ImageAsset { url?: string; assetId?: string }
interface EventDoc {
  _id: string;
  title?: { en?: string; ko?: string };
  date?: string;
  images?: { en?: ImageAsset; ko?: ImageAsset }[];
  links?: { label: string; url: string }[];
}

interface QRHit {
  eventId: string;
  eventTitle: string;
  imageIndex: number;
  lang: 'en' | 'ko';
  assetId: string;
  qrText: string;
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function decodeQR(buf: Buffer): Promise<string | null> {
  // Try multiple sizes — QR scanners are sensitive to scale
  for (const width of [800, 1200, 1600]) {
    try {
      const { data, info } = await sharp(buf)
        .resize({ width, withoutEnlargement: true })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
        inversionAttempts: 'attemptBoth',
      });
      if (code?.data) return code.data;
    } catch {
      // try next size
    }
  }
  return null;
}

function normalizeUrl(s: string): string {
  if (!s) return s;
  // Treat http/https equivalent, strip trailing slash, lowercase host
  try {
    const u = new URL(s);
    return `${u.protocol.replace(':', '')}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return s.trim();
  }
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

async function main() {
  loadEnv(join(homedir(), '.config', '.env.d'));

  const args = process.argv.slice(2);
  const seIdx = args.indexOf('--studio-env');
  if (seIdx >= 0) loadEnv(resolve(args[seIdx + 1]));
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? resolve(args[outIdx + 1]) : null;

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

  console.log('Fetching events...');
  const events = (await client.fetch(`*[_type == "event"] | order(_id) {
    _id, title, date,
    "images": images[]{ "en": en.asset->{url, "assetId": _id}, "ko": ko.asset->{url, "assetId": _id} },
    links
  }`)) as EventDoc[];
  console.log(`  ${events.length} events`);

  const hits: QRHit[] = [];
  const cache = new Map<string, string | null>(); // assetId -> qr text
  let scanned = 0;
  let imageCount = 0;

  for (const evt of events) {
    if (!evt.images?.length) continue;
    for (let i = 0; i < evt.images.length; i++) {
      const pair = evt.images[i];
      for (const lang of ['en', 'ko'] as const) {
        const asset = pair[lang];
        if (!asset?.url || !asset.assetId) continue;
        imageCount++;
        let qr = cache.get(asset.assetId);
        if (qr === undefined) {
          process.stdout.write(`  [${++scanned}] ${evt._id} images[${i}].${lang} (${asset.assetId.slice(0, 30)})... `);
          const buf = await fetchImage(asset.url);
          qr = buf ? await decodeQR(buf) : null;
          cache.set(asset.assetId, qr);
          console.log(qr ? `QR: ${qr.slice(0, 80)}` : 'no QR');
        }
        if (qr) {
          hits.push({
            eventId: evt._id,
            eventTitle: evt.title?.en || '(no title)',
            imageIndex: i,
            lang,
            assetId: asset.assetId,
            qrText: qr,
          });
        }
      }
    }
  }

  console.log(`\nScanned ${imageCount} images (${cache.size} unique). Found ${hits.length} QR hits across ${new Set(hits.map((h) => h.eventId)).size} events.`);

  // Group by normalized QR URL/text
  const byQR = new Map<string, QRHit[]>();
  for (const h of hits) {
    const key = isUrl(h.qrText) ? normalizeUrl(h.qrText) : h.qrText.trim();
    const arr = byQR.get(key) || [];
    arr.push(h);
    byQR.set(key, arr);
  }

  // Build report
  const lines: string[] = [];
  lines.push('# QR Code Audit Report');
  lines.push('');
  lines.push(`- Events: ${events.length}`);
  lines.push(`- Images scanned: ${imageCount}`);
  lines.push(`- QR hits: ${hits.length}`);
  lines.push(`- Unique QR values: ${byQR.size}`);
  lines.push('');

  // Merge candidates: same QR shared by multiple distinct events
  const mergeGroups = Array.from(byQR.entries())
    .map(([qr, hs]) => ({ qr, eventIds: [...new Set(hs.map((h) => h.eventId))], hits: hs }))
    .filter((g) => g.eventIds.length > 1);

  lines.push('## Merge candidates (shared QR across distinct events)');
  lines.push('');
  if (mergeGroups.length === 0) {
    lines.push('_None — no QR is shared between distinct events._');
  } else {
    for (const g of mergeGroups) {
      lines.push(`### QR: \`${g.qr}\``);
      lines.push('');
      const evtMap = new Map(events.map((e) => [e._id, e]));
      for (const eid of g.eventIds) {
        const e = evtMap.get(eid);
        lines.push(`- \`${eid}\` — ${e?.title?.en || '(no title)'} (${e?.date || 'no date'})`);
      }
      lines.push('');
    }
  }
  lines.push('');

  // Link backfill: events with QR URL not in links[]
  lines.push('## Link backfill (QR URL missing from links[])');
  lines.push('');
  const evtMap = new Map(events.map((e) => [e._id, e]));
  const backfills: { eventId: string; title: string; qrUrl: string }[] = [];
  for (const h of hits) {
    if (!isUrl(h.qrText)) continue;
    const evt = evtMap.get(h.eventId);
    const existing = (evt?.links || []).map((l) => normalizeUrl(l.url));
    const norm = normalizeUrl(h.qrText);
    if (!existing.includes(norm)) {
      backfills.push({ eventId: h.eventId, title: h.eventTitle, qrUrl: h.qrText });
    }
  }
  // Dedup by event+url
  const seen = new Set<string>();
  const unique = backfills.filter((b) => {
    const key = `${b.eventId}|${normalizeUrl(b.qrUrl)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    lines.push('_None — every detected QR URL is already in its event\'s links[]._');
  } else {
    for (const b of unique) {
      lines.push(`- \`${b.eventId}\` — **${b.title}** -> \`${b.qrUrl}\``);
    }
  }
  lines.push('');

  // Per-event detail
  lines.push('## Per-event QR inventory');
  lines.push('');
  const eventToHits = new Map<string, QRHit[]>();
  for (const h of hits) {
    const arr = eventToHits.get(h.eventId) || [];
    arr.push(h);
    eventToHits.set(h.eventId, arr);
  }
  for (const evt of events) {
    const evHits = eventToHits.get(evt._id);
    if (!evHits?.length) continue;
    lines.push(`### \`${evt._id}\` — ${evt.title?.en}`);
    lines.push('');
    for (const h of evHits) {
      lines.push(`- images[${h.imageIndex}].${h.lang}: \`${h.qrText}\``);
    }
    lines.push('');
  }

  const report = lines.join('\n');
  if (outPath) {
    writeFileSync(outPath, report);
    console.log(`\nReport written to ${outPath}`);
  } else {
    console.log('\n' + report);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
