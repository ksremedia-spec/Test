#!/usr/bin/env node
/**
 * The 20-job production validation (2 Sep 2026, Kyle: "run the actual
 * pipeline with 5 photos of each transform... come back to me with hard
 * data"). Uploads 20 real photos through the live site on the probe account,
 * starts one job each, polls to completion, and writes per-job stats to
 * /tmp/validation-batch.json. Submission is staggered a few seconds apart —
 * the shape of a real bulk upload.
 */
import fs from 'node:fs';

const SITE = 'https://thelistinglab.app';
const COOKIE = JSON.parse(fs.readFileSync('/tmp/probe-session.json', 'utf8')).cookie;
const H = { cookie: COOKIE };

const ROSTER = [
  // declutter — the graded bench set, easy to hardest
  { t: 'declutter', file: '/tmp/dec-a-orig.jpg',  name: 'living-room (light)' },
  { t: 'declutter', file: '/tmp/dec-b-orig.jpg',  name: 'kitchen (counters+fridge)' },
  { t: 'declutter', file: '/tmp/nur-orig.jpg',    name: 'nursery (reference standard)' },
  { t: 'declutter', file: '/tmp/dec-bd1-orig.jpg', name: 'messy bedroom 1' },
  { t: 'declutter', file: '/tmp/dec-bd2-orig.jpg', name: 'messy bedroom 2 (hardest)' },
  // empty — same furnished rooms; bd2 tests Kyle's "extreme clutter → empty" routing
  { t: 'empty', file: '/tmp/dec-a-orig.jpg',  name: 'living-room' },
  { t: 'empty', file: '/tmp/dec-b-orig.jpg',  name: 'kitchen' },
  { t: 'empty', file: '/tmp/nur-orig.jpg',    name: 'nursery' },
  { t: 'empty', file: '/tmp/dec-bd1-orig.jpg', name: 'messy bedroom 1' },
  { t: 'empty', file: '/tmp/dec-bd2-orig.jpg', name: 'messy bedroom 2' },
  // staging — golden empty rooms, styles varied
  { t: 'staging', file: 'pipeline/golden/images/k-living.jpg',  name: 'k-living',  room: 'Living Room', style: 'Standard' },
  { t: 'staging', file: 'pipeline/golden/images/k-bedroom.jpg', name: 'k-bedroom', room: 'Primary Bedroom', style: 'Standard' },
  { t: 'staging', file: 'pipeline/golden/images/k-office.jpg',  name: 'k-office',  room: 'Home Office', style: 'Modern' },
  { t: 'staging', file: 'pipeline/golden/images/living.jpg',    name: 'living',    room: 'Living Room', style: 'Coastal' },
  { t: 'staging', file: 'pipeline/golden/images/c101_k-living.original.jpg', name: 'c101-reference', room: 'Living Room', style: 'Luxury' },
  // twilight — 2 golden + 3 real customer exteriors (twi-1 is a 12.5MB stress case)
  { t: 'twilight', file: 'pipeline/golden/images/colonial.jpg', name: 'colonial' },
  { t: 'twilight', file: 'pipeline/golden/images/exterior.jpg', name: 'exterior' },
  { t: 'twilight', file: '/tmp/twi-1.jpg', name: 'street-house (12.5MB)' },
  { t: 'twilight', file: '/tmp/twi-2.jpg', name: 'grey-victorian' },
  { t: 'twilight', file: '/tmp/twi-3.jpg', name: 'shingle-house' },
];

async function api(path, opts = {}) {
  const r = await fetch(SITE + path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}

const jobs = [];
for (const item of ROSTER) {
  const bytes = fs.readFileSync(item.file);
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), item.name.replace(/[^a-z0-9-]/gi, '_') + '.jpg');
  const up = await api('/api/photos', { method: 'POST', body: form });
  if (up.status !== 200 && up.status !== 201) { console.log('UPLOAD FAIL', item.t, item.name, up.status, JSON.stringify(up.body).slice(0, 150)); continue; }
  const photoId = up.body.photo?.id || up.body.id || up.body.photoId;
  // The scene classify runs async; staging refuses furnished rooms, so give
  // it a beat on staging uploads before starting the job.
  if (item.t === 'staging') await new Promise(r => setTimeout(r, 6000));
  const payload = { photoId, transformation: item.t };
  if (item.t === 'staging') { payload.style = item.style; payload.roomType = item.room; }
  let tr = await api('/api/transform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (tr.status === 409 || (tr.body.error && /furnished|classif/i.test(JSON.stringify(tr.body)))) {
    await new Promise(r => setTimeout(r, 8000));
    tr = await api('/api/transform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  }
  const jobId = tr.body.job?.id || tr.body.jobId || tr.body.id;
  const rec = { t: item.t, name: item.name, photoId, jobId, submittedAt: new Date().toISOString(), status: tr.status, error: jobId ? null : JSON.stringify(tr.body).slice(0, 200) };
  jobs.push(rec);
  console.log(jobId ? `submitted ${item.t.padEnd(9)} ${item.name} → ${jobId}` : `SUBMIT FAIL ${item.t} ${item.name}: ${rec.error}`);
  fs.writeFileSync('/tmp/validation-batch.json', JSON.stringify({ startedAt: jobs[0]?.submittedAt, jobs }, null, 1));
  await new Promise(r => setTimeout(r, 3000));
}
console.log(`\n${jobs.filter(j => j.jobId).length}/${ROSTER.length} submitted; polling…`);

// Poll until every job is terminal.
const terminal = new Set(['delivered', 'rejected', 'failed']);
for (let tick = 0; tick < 240; tick++) {
  await new Promise(r => setTimeout(r, 30000));
  const list = await api('/api/jobs');
  const byId = {};
  for (const j of (list.body.jobs || [])) byId[j.id] = j;
  let done = 0, lines = [];
  for (const rec of jobs) {
    if (!rec.jobId) { done++; continue; }
    const j = byId[rec.jobId];
    if (!j) continue;
    rec.live = { status: j.status, finishedAt: j.finishedAt || null, rejectionNote: j.rejectionNote || null, attemptsUsed: j.attemptsUsed };
    if (terminal.has(j.status)) done++;
    else lines.push(`${rec.t}/${rec.name}: ${j.status}`);
  }
  fs.writeFileSync('/tmp/validation-batch.json', JSON.stringify({ startedAt: jobs[0]?.submittedAt, jobs }, null, 1));
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${done}/${jobs.length} terminal` + (lines.length ? ` — running: ${lines.slice(0, 4).join('; ')}` : ''));
  if (done === jobs.length) break;
}
console.log('BATCH COMPLETE');
