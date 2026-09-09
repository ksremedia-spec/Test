#!/usr/bin/env node
/**
 * Validation batch 2 (2 Sep 2026, Kyle: "run 20 more unique images") — reads
 * /tmp/b2/roster.json, submits through the live site on the probe account,
 * polls to completion, writes /tmp/validation-batch2.json. Supports fromJob
 * entries (server-side clean-frame copy — the "Stage this room" chained flow).
 */
import fs from 'node:fs';
const SITE = 'https://thelistinglab.app';
const COOKIE = JSON.parse(fs.readFileSync('/tmp/probe-session.json', 'utf8')).cookie;
const ROSTER = JSON.parse(fs.readFileSync('/tmp/b2/roster.json', 'utf8'));

async function api(path, opts = {}) {
  const r = await fetch(SITE + path, { ...opts, headers: { cookie: COOKIE, ...(opts.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}

const jobs = [];
for (const item of ROSTER) {
  let photoId = null, up = null;
  if (item.fromJob) {
    up = await api('/api/photos/from-job', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: item.fromJob }) });
    photoId = up.body.photo?.id || up.body.id || up.body.photoId;
  } else {
    const bytes = fs.readFileSync(item.file);
    const form = new FormData();
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), item.name + '.jpg');
    up = await api('/api/photos', { method: 'POST', body: form });
    photoId = up.body.photo?.id || up.body.id || up.body.photoId;
  }
  if (!photoId) { jobs.push({ ...item, error: 'upload: ' + JSON.stringify(up.body).slice(0, 150) }); console.log('UPLOAD FAIL', item.t, item.name); continue; }
  if (item.t === 'staging') await new Promise(r => setTimeout(r, 6000));
  const payload = { photoId, transformation: item.t };
  if (item.t === 'staging') { payload.style = item.style; payload.roomType = item.room; }
  let tr = await api('/api/transform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!(tr.body.job?.id || tr.body.jobId)) {
    await new Promise(r => setTimeout(r, 8000));
    tr = await api('/api/transform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  }
  const jobId = tr.body.job?.id || tr.body.jobId || null;
  jobs.push({ t: item.t, name: item.name, room: item.room, style: item.style, photoId, jobId, submittedAt: new Date().toISOString(), error: jobId ? null : JSON.stringify(tr.body).slice(0, 200) });
  console.log(jobId ? `submitted ${item.t.padEnd(9)} ${item.name} → ${jobId}` : `SUBMIT FAIL ${item.t} ${item.name}: ${jobs.at(-1).error}`);
  fs.writeFileSync('/tmp/validation-batch2.json', JSON.stringify({ jobs }, null, 1));
  await new Promise(r => setTimeout(r, 3000));
}
console.log(`\n${jobs.filter(j => j.jobId).length}/${ROSTER.length} submitted; polling…`);

const terminal = new Set(['delivered', 'rejected', 'failed']);
for (let tick = 0; tick < 240; tick++) {
  await new Promise(r => setTimeout(r, 30000));
  const list = await api('/api/jobs');
  const byId = {}; for (const j of (list.body.jobs || [])) byId[j.jobId] = j;
  let done = 0; const running = [];
  for (const rec of jobs) {
    if (!rec.jobId) { done++; continue; }
    const j = byId[rec.jobId]; if (!j) continue;
    rec.live = { status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt || null, note: j.note || null };
    if (terminal.has(j.status)) done++; else running.push(`${rec.t}/${rec.name}:${j.status}`);
  }
  fs.writeFileSync('/tmp/validation-batch2.json', JSON.stringify({ jobs }, null, 1));
  console.log(`[${new Date().toISOString().slice(11,19)}] ${done}/${jobs.length} terminal` + (running.length ? ' — ' + running.slice(0,5).join('; ') : ''));
  if (done === jobs.length) break;
}
console.log('BATCH2 COMPLETE');
