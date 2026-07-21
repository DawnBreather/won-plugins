// One-off: derive machine-readable schedule metadata for existing events.
// Reads each event's full context (date/time strings + fullDescription, both
// languages) and classifies via Gemini into { scheduleKind, dates, recurrence }.
// Writes studio/SCHEDULE_PLAN.md for human review. Does NOT write to Sanity.
//
// Usage: bun run derive-schedule.mjs   (run from studio/)
//   env: SANITY_* from ./.env, GEMINI_API_KEY from ~/.config/.env.d
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createClient } from '@sanity/client';
import { GoogleGenAI } from '@google/genai';

// "Today" is passed to the model for year inference. Keep in sync when re-running.
const TODAY = '2026-07-20';

function loadEnv(path, into) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) into[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
const STUDIO_DIR = '/Users/temporary/lab/church/ccs-events-seattle-clone/studio';
const E = {};
loadEnv(STUDIO_DIR + '/.env', E);
loadEnv(homedir() + '/.config/.env.d', E);

const client = createClient({
  projectId: E.SANITY_STUDIO_PROJECT_ID, dataset: 'production',
  apiVersion: '2025-01-01', useCdn: false, token: E.SANITY_AUTH_TOKEN,
});
const ai = new GoogleGenAI({ apiKey: E.GEMINI_API_KEY });

const SCHEMA = {
  type: 'object',
  properties: {
    scheduleKind: { type: 'string', enum: ['once', 'recurring', 'ongoing', 'unknown'] },
    startDate: { type: 'string', description: 'YYYY-MM-DD or empty' },
    endDate: { type: 'string', description: 'YYYY-MM-DD or empty' },
    startTime: { type: 'string', description: 'HH:MM 24h or empty' },
    endTime: { type: 'string', description: 'HH:MM 24h or empty' },
    recFreq: { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'none'], description: '"none" when not recurring' },
    recWeekday: { type: 'integer', description: '0=Sun..6=Sat, or -1 if n/a' },
    recNote: { type: 'string' },
    yearInferred: { type: 'boolean', description: 'true if the year was not explicit in the source and you inferred it' },
    needsReview: { type: 'boolean' },
    reasoning: { type: 'string', description: 'one sentence' },
  },
  required: ['scheduleKind', 'yearInferred', 'needsReview', 'reasoning'],
};

const PROMPT = (e) => `You classify a church event's schedule for a calendar. Today is ${TODAY} (Pacific Time).

Classify into exactly one scheduleKind:
- "once": a specific dated event or date range (e.g. "July 9-10", "8/16 - 8/26"). Fill startDate (and endDate if a range), and startTime/endTime if a clock time is stated anywhere.
- "recurring": repeats on a cadence (e.g. "Every Sunday", "Every Friday 7PM", "every other Tuesday", "Every Month"). Fill recFreq (weekly/biweekly/monthly) and recWeekday for weekly/biweekly. Do NOT set dates.
- "ongoing": no calendar slot (e.g. "Ongoing", "All Year Around", "2026", "Starting April", "Anytime", sign-up forms open indefinitely).
- "unknown": genuinely cannot tell.

Rules:
- Read the WHOLE event (date, time, and full description in both languages). The description often has the real date/time even when the date string is vague or bilingual.
- Times are Pacific. Convert "7:00 PM" -> "19:00", "4:20-7:00 PM" -> start 16:20 end 19:00.
- YEAR: if the source has no explicit year and you infer one from "today", set yearInferred=true.
- Set needsReview=true whenever: yearInferred is true, the kind is "unknown", or anything is ambiguous. Never fabricate a date you are not confident about — prefer needsReview.
- recWeekday: Sun=0..Sat=6, use -1 when not applicable.

EVENT
Title (EN): ${e.tEn}
Title (KO): ${e.tKo || '(none)'}
Date string: ${e.date}
Time string: ${e.time}
Full description (EN): ${e.fEn || '(none)'}
Full description (KO): ${e.fKo || '(none)'}
Publish end date: ${e.end || '(none)'}`;

const rows = await client.fetch(
  `*[_type=="event" && !(_id in path("drafts.**"))]{
     _id,"tEn":title.en,"tKo":title.ko,"date":date,"time":time,
     "fEn":fullDescription.en,"fKo":fullDescription.ko,"end":publishEndDate
   } | order(_id)`
);

console.log(`Deriving schedule for ${rows.length} events...`);
const results = [];
for (const e of rows) {
  process.stdout.write(`  ${e.tEn} ... `);
  try {
    const res = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [{ role: 'user', parts: [{ text: PROMPT(e) }] }],
      config: { responseMimeType: 'application/json', responseSchema: SCHEMA },
    });
    const parsed = JSON.parse(res.candidates[0].content.parts.map((p) => p.text).join(''));
    results.push({ e, d: parsed });
    console.log(`${parsed.scheduleKind}${parsed.needsReview ? ' [review]' : ''}`);
  } catch (err) {
    results.push({ e, d: { scheduleKind: 'unknown', needsReview: true, reasoning: 'ERROR: ' + err.message } });
    console.log('FAIL ' + err.message);
  }
}

// ---- write review file ----
const fmtRec = (d) => {
  if (d.scheduleKind !== 'recurring') return '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = d.recWeekday >= 0 && d.recWeekday <= 6 ? ` ${wd[d.recWeekday]}(${d.recWeekday})` : '';
  return `${d.recFreq}${day}${d.recNote ? ` — ${d.recNote}` : ''}`;
};
const block = ({ e, d }) => {
  const lines = [`## ${e.tEn}`, '', `- _id: \`${e._id}\``,
    `- source date: \`${e.date}\` | time: \`${e.time}\``,
    `- **kind: ${d.scheduleKind}**${d.needsReview ? '  ⚠️ NEEDS REVIEW' : ''}`];
  if (d.scheduleKind === 'once') {
    lines.push(`- start: \`${d.startDate || '?'}\`${d.endDate && d.endDate !== d.startDate ? ` -> end: \`${d.endDate}\`` : ''}`);
    if (d.startTime) lines.push(`- time: \`${d.startTime}\`${d.endTime ? ` - \`${d.endTime}\`` : ''}`);
    if (d.yearInferred) lines.push(`- ⚠️ year INFERRED (confirm)`);
  } else if (d.scheduleKind === 'recurring') {
    lines.push(`- recurrence: \`${fmtRec(d)}\``);
  }
  lines.push(`- reasoning: ${d.reasoning}`, '');
  return lines.join('\n');
};

const review = results.filter((r) => r.d.needsReview);
const clean = results.filter((r) => !r.d.needsReview);
const md = [
  `# Schedule Derivation Plan — ${TODAY}`, '',
  `Derived by \`derive-schedule.mjs\`. Review, correct any misreads, then run \`apply-schedule.mjs\`.`,
  `Total: ${results.length} | needs review: ${review.length} | clean: ${clean.length}`, '',
  '---', '', `# ⚠️ NEEDS REVIEW (${review.length})`, '',
  ...review.map(block),
  '---', '', `# Derived cleanly (${clean.length})`, '',
  ...clean.map(block),
].join('\n');

const outPath = STUDIO_DIR + '/SCHEDULE_PLAN.md';
writeFileSync(outPath, md);
// also dump raw json for the apply step
writeFileSync(STUDIO_DIR + '/SCHEDULE_PLAN.json',
  JSON.stringify(results.map((r) => ({ id: r.e._id, tEn: r.e.tEn, ...r.d })), null, 2));
console.log(`\nWrote ${outPath}`);
console.log(`  needs review: ${review.length}, clean: ${clean.length}`);
