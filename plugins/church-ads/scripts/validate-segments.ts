#!/usr/bin/env bun
/**
 * Gate on segments.json before anything is pushed to Sanity.
 *
 * Every check here exists because the corresponding failure actually shipped:
 *
 *  - UNKNOWN/camelCase keys      apply-plan.ts reads snake_case (`start_date`,
 *                                `schedule_kind`, ...). A camelCase edit is
 *                                silently ignored and the stale Gemini value
 *                                publishes. Three events went live with 2020
 *                                dates this way while the visible card read 2026.
 *  - implausible year            Gemini invents a year when the slide prints
 *                                only `8/31-11/16`. It chose 2020.
 *  - weekday mismatch           The slide often prints the weekday (`(Fri)`,
 *                                `매주 월`). If the date's real weekday differs,
 *                                the year or the day is wrong.
 *  - placeholder / unreachable   `https://example.com/teacher-recruit` shipped as
 *    URL                         a dead "Sign Up" button; `moli.seattlehyungje.org`
 *                                does not resolve at all. Both were invented.
 *  - dot in a derived _id        A Sanity document id containing `.` is private,
 *                                so a tokenless static build reads zero rows.
 *  - unknown category key        Nothing validates a `_ref` on write, so a typo'd
 *                                key is stored as a dangling reference. The site's
 *                                `alsoShowIn[]->` then resolves it to a null ENTRY
 *                                inside the array — a chip that quietly never lists
 *                                the event, with no error anywhere.
 *
 * Usage:
 *   bun run validate-segments.ts --out <YYYYMMDD.church-ads dir> [--check-urls]
 *
 * Exits non-zero if any ERROR is found. Warnings do not fail the run.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Keys apply-plan.ts / rewrite-mds.ts actually consume. Anything else in an ad
// object is either dead weight or, worse, a misspelling of one of these.
const KNOWN_AD_KEYS = new Set([
  'index', 'slug', 'category_key', 'also_show_in', 'title', 'date', 'time', 'location',
  'description', 'full_description', 'links', 'page_indices', 'regen_prompt',
  'transcript_chunk', 'featured', 'primary',
  'schedule_kind', 'start_date', 'end_date', 'start_time', 'end_time',
  'rec_freq', 'rec_weekday', 'rec_anchor_date', 'rec_day_of_month',
  'note', 'publish_end_date',
]);

// camelCase spellings of consumed keys — the exact trap that shipped 2020 dates.
const CAMEL_TRAPS: Record<string, string> = {
  scheduleKind: 'schedule_kind', startDate: 'start_date', endDate: 'end_date',
  startTime: 'start_time', endTime: 'end_time', recFreq: 'rec_freq',
  recWeekday: 'rec_weekday', recAnchorDate: 'rec_anchor_date',
  recDayOfMonth: 'rec_day_of_month', fullDescription: 'full_description',
  categoryKey: 'category_key', pageIndices: 'page_indices',
  publishEndDate: 'publish_end_date', regenPrompt: 'regen_prompt',
  alsoShowIn: 'also_show_in',
};

// The six category documents that exist in Sanity (`_id` = `category-<key>`).
// Hardcoded because this gate runs offline, before any token is needed; apply-plan.ts
// re-checks against the live category list so a seventh category cannot break the push.
const CATEGORY_KEYS = new Set([
  'college', 'youngAdult', 'adult', 'newcomer', 'specialEvents', 'general',
]);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KO_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const errors: string[] = [];
const warnings: string[] = [];
const err = (m: string) => errors.push(m);
const warn = (m: string) => warnings.push(m);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Weekday tokens the slide/date text claims, from EN abbreviations or KO 요일. */
function claimedWeekdays(text: string): number[] {
  const out = new Set<number>();
  for (const [i, w] of WEEKDAYS.entries()) {
    if (new RegExp(`\\b${w}(day|s)?\\b`, 'i').test(text)) out.add(i);
  }
  for (const [i, w] of KO_WEEKDAYS.entries()) {
    if (new RegExp(`(매주\\s*${w}|\\(${w}\\)|${w}요일)`).test(text)) out.add(i);
  }
  return [...out];
}

async function urlReachable(url: string): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(url, { redirect: 'follow', signal: c.signal });
    clearTimeout(t);
    return r.status < 400;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--out');
  if (oi < 0) throw new Error('Missing --out <YYYYMMDD.church-ads dir>');
  const outDir = resolve(args[oi + 1]);
  const checkUrls = args.includes('--check-urls');

  const segPath = join(outDir, 'raw', 'segments.json');
  if (!existsSync(segPath)) throw new Error(`Not found: ${segPath}`);
  const { ads } = JSON.parse(readFileSync(segPath, 'utf8')) as { ads: any[] };

  const thisYear = new Date().getUTCFullYear();
  const slugs = new Set<string>();

  for (const ad of ads) {
    const at = `ad ${ad.index} (${ad.slug})`;

    // --- key hygiene: the silent-ignore trap ---
    for (const k of Object.keys(ad)) {
      if (CAMEL_TRAPS[k]) {
        err(`${at}: key "${k}" is camelCase and is NEVER READ. Use "${CAMEL_TRAPS[k]}". ` +
            `Both spellings can coexist, so the stale snake_case value would publish instead.`);
      } else if (!KNOWN_AD_KEYS.has(k)) {
        warn(`${at}: unrecognised key "${k}" — nothing consumes it.`);
      }
    }

    // --- derived Sanity _id must be dot-free (a dot makes the doc private) ---
    if (typeof ad.slug !== 'string' || !ad.slug) {
      err(`${at}: missing slug.`);
    } else {
      if (ad.slug.includes('.')) {
        err(`${at}: slug contains "." -> _id "event-${ad.slug}" would be a PRIVATE Sanity doc, ` +
            `invisible to the tokenless site build.`);
      }
      if (slugs.has(ad.slug)) err(`${at}: duplicate slug "${ad.slug}" — one ad would overwrite the other.`);
      slugs.add(ad.slug);
    }

    // --- categories: the KEY was only ever spell-checked, never valued ---
    // A bogus key is accepted by the Sanity API and stored as a dangling `_ref`.
    // The primary then reads as an empty badge; an extra becomes a null entry in
    // `alsoShowIn[]->` and its chip silently omits the event.
    const valid = [...CATEGORY_KEYS].join(', ');
    if (typeof ad.category_key !== 'string' || !CATEGORY_KEYS.has(ad.category_key)) {
      err(`${at}: category_key "${ad.category_key}" is not a real category. Valid: ${valid}.`);
    }
    if (ad.also_show_in !== undefined) {
      if (!Array.isArray(ad.also_show_in)) {
        err(`${at}: also_show_in must be an array of category keys, got ${typeof ad.also_show_in}.`);
      } else {
        const seen = new Set<string>();
        for (const k of ad.also_show_in) {
          if (typeof k !== 'string' || !CATEGORY_KEYS.has(k)) {
            err(`${at}: also_show_in entry "${k}" is not a real category. Valid: ${valid}.`);
          } else if (k === ad.category_key) {
            err(`${at}: also_show_in repeats the primary category "${k}". The primary already ` +
                `lists the event under that chip; keep extras disjoint from it.`);
          } else if (seen.has(k)) {
            err(`${at}: also_show_in lists "${k}" twice. GROQ does not dedupe, so the resolved ` +
                `array would carry two identical entries.`);
          }
          if (typeof k === 'string') seen.add(k);
        }
      }
    }

    // --- dates: plausible year, and weekday agreeing with the printed text ---
    const dateText = [ad.date, ad.time, ad.title?.en, ad.title?.ko, ad.description?.ko]
      .filter(Boolean).join(' ');
    for (const key of ['start_date', 'end_date', 'rec_anchor_date']) {
      const v = ad[key];
      if (!v) continue;
      if (!ISO.test(v)) { err(`${at}: ${key}="${v}" is not YYYY-MM-DD.`); continue; }
      const year = Number(v.slice(0, 4));
      if (year < thisYear || year > thisYear + 2) {
        err(`${at}: ${key}="${v}" has implausible year ${year} (expected ${thisYear}..${thisYear + 2}). ` +
            `Slides usually print no year and the segment step invents one.`);
      }
      const claims = claimedWeekdays(dateText);
      if (claims.length && !claims.includes(weekdayOf(v))) {
        err(`${at}: ${key}="${v}" falls on ${WEEKDAYS[weekdayOf(v)]}, but the ad text claims ` +
            `${claims.map((c) => WEEKDAYS[c]).join('/')}. Year or day is wrong.`);
      }
    }
    if (ad.start_date && ad.end_date && ad.end_date < ad.start_date) {
      err(`${at}: end_date ${ad.end_date} precedes start_date ${ad.start_date}.`);
    }

    // --- schedule shape ---
    if (ad.schedule_kind === 'once' && !ad.start_date) {
      err(`${at}: schedule_kind "once" needs a start_date.`);
    }
    if (ad.schedule_kind === 'recurring') {
      if (!ad.rec_freq || ad.rec_freq === 'none') {
        err(`${at}: schedule_kind "recurring" needs rec_freq (weekly/biweekly/monthly).`);
      } else if (ad.rec_freq !== 'monthly' && typeof ad.rec_weekday !== 'number') {
        err(`${at}: rec_freq "${ad.rec_freq}" needs rec_weekday (0=Sun..6=Sat).`);
      }
      // a recurring course must not also carry a one-off span
      if (ad.start_date) {
        warn(`${at}: recurring ad also has start_date "${ad.start_date}" — apply-plan ignores it ` +
             `for recurring, so it is dead. Put the span in note instead.`);
      }
    }
    for (const [k, re] of [['start_time', /^([01]\d|2[0-3]):[0-5]\d$/], ['end_time', /^([01]\d|2[0-3]):[0-5]\d$/]] as const) {
      if (ad[k] && !re.test(ad[k])) err(`${at}: ${k}="${ad[k]}" is not 24-hour HH:MM.`);
    }

    // --- links: no invented URLs ---
    for (const l of ad.links ?? []) {
      const u: string = l?.url ?? '';
      if (!u) { err(`${at}: link "${l?.label}" has no url.`); continue; }
      if (/example\.(com|org|net)/i.test(u)) {
        err(`${at}: link "${u}" is a PLACEHOLDER. Leave links empty rather than shipping a dead button.`);
      }
      if (!/^(https?:|tel:|mailto:)/.test(u)) err(`${at}: link "${u}" has no usable scheme.`);
    }
  }

  // --- same URL on unrelated ads = hallucination tell (multi-page ads exempt) ---
  const byUrl = new Map<string, { slug: string; pages: number[] }[]>();
  for (const ad of ads) {
    for (const l of ad.links ?? []) {
      if (!l?.url || l.url.startsWith('tel:')) continue;
      const arr = byUrl.get(l.url) ?? [];
      arr.push({ slug: ad.slug, pages: ad.page_indices ?? [] });
      byUrl.set(l.url, arr);
    }
  }
  for (const [url, users] of byUrl) {
    if (users.length < 2) continue;
    const pages = new Set(users.flatMap((u) => u.pages));
    // Same ad spanning several pages is fine; genuinely different ads are not.
    warn(`URL reused by ${users.length} ads (${users.map((u) => u.slug).join(', ')}): ${url}. ` +
         `Legitimate only if these are one ad across pages [${[...pages].join(', ')}] — otherwise it is invented.`);
  }

  // --- optional: every http(s) link must actually resolve ---
  if (checkUrls) {
    for (const ad of ads) {
      for (const l of ad.links ?? []) {
        if (!/^https?:/.test(l?.url ?? '')) continue;
        if (!(await urlReachable(l.url))) {
          err(`ad ${ad.index} (${ad.slug}): link does not resolve: ${l.url}`);
        }
      }
    }
  }

  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(`\n${ads.length} ads checked — ${errors.length} error(s), ${warnings.length} warning(s).`);
  if (errors.length) {
    console.log('Fix the errors above before running apply-plan.ts.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(2); });
