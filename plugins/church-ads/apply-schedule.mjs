// One-off: apply the reviewed schedule dataset (SCHEDULE_REVIEWED.json) to Sanity.
// Surgical: sets ONLY schedule.* fields via .set(), never touches date/time/title/images.
// Verifies every id exists first; refuses to run if any id is unknown.
import { readFileSync } from 'node:fs';
import { createClient } from '@sanity/client';

const STUDIO_DIR = '/Users/temporary/lab/church/ccs-events-seattle-clone/studio';
const E = {};
for (const l of readFileSync(STUDIO_DIR + '/.env', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) E[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const client = createClient({
  projectId: E.SANITY_STUDIO_PROJECT_ID, dataset: 'production',
  apiVersion: '2025-01-01', useCdn: false, token: E.SANITY_AUTH_TOKEN,
});

const rows = JSON.parse(readFileSync(STUDIO_DIR + '/SCHEDULE_REVIEWED.json', 'utf8'));

// Guard: every id must exist as a published event.
const existing = new Set(await client.fetch(`*[_type=="event" && !(_id in path("drafts.**"))]._id`));
const missing = rows.filter((r) => !existing.has(r.id));
if (missing.length) {
  console.error('ABORT — unknown ids:', missing.map((m) => `${m.id} (${m.t})`).join(', '));
  process.exit(1);
}
console.log(`All ${rows.length} ids exist. Applying...`);

for (const r of rows) {
  const set = { scheduleKind: r.kind };
  const unset = [];
  if (r.kind === 'once') {
    set.startDate = r.startDate;
    set.endDate = r.endDate || r.startDate;
    if (r.startTime) set.startTime = r.startTime; else unset.push('startTime');
    if (r.endTime) set.endTime = r.endTime; else unset.push('endTime');
    unset.push('recurrence');
  } else if (r.kind === 'recurring') {
    const rec = { freq: r.recFreq };
    if (r.recWeekday !== undefined && r.recWeekday >= 0) rec.weekday = r.recWeekday;
    if (r.recNote) rec.note = r.recNote;
    set.recurrence = rec;
    if (r.startTime) set.startTime = r.startTime; else unset.push('startTime');
    if (r.endTime) set.endTime = r.endTime; else unset.push('endTime');
    unset.push('startDate', 'endDate');
  } else {
    // ongoing: no date/time/recurrence
    unset.push('startDate', 'endDate', 'startTime', 'endTime', 'recurrence');
  }
  let p = client.patch(r.id).set(set);
  if (unset.length) p = p.unset(unset);
  await p.commit();
  console.log(`  ${r.kind.padEnd(9)} ${r.t}`);
}
console.log('\nDone.');
