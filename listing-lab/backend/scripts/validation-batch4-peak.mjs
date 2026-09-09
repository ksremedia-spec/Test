#!/usr/bin/env node
/**
 * The 2pm PEAK rerun (2 Sep 2026, Kyle: "we will also do it again at 2pm but
 * more to test the pipeline then"). Resubmits the exact jobs from the midday
 * fresh-photo battery (/tmp/validation-batch3.json) at weekday peak — same
 * photos, same options, so any delta is pure traffic. Writes
 * /tmp/validation-batch4.json.
 */
import fs from 'node:fs';
const SITE = 'https://thelistinglab.app';
const COOKIE = JSON.parse(fs.readFileSync('/tmp/probe-session.json', 'utf8')).cookie;
const prev = JSON.parse(fs.readFileSync('/tmp/validation-batch3.json', 'utf8')).jobs;

async function api(path, opts = {}) {
  const r = await fetch(SITE + path, { ...opts, headers: { cookie: COOKIE, ...(opts.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}
const jobs = [];
for (const p of prev) {
  if (!p.photoId) continue;
  const payload = { photoId: p.photoId, transformation: p.t };
  if (p.t === 'staging') { payload.style = p.style; payload.roomType = p.room; }
  let tr = await api('/api/transform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!(tr.body.job?.id || tr.body.jobId)) {
    await new Promise(r => setTimeout(r, 8000));
    tr = await api('/api/transform', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  }
  const jobId = tr.body.job?.id || tr.body.jobId || null;
  jobs.push({ t: p.t, name: p.name, photoId: p.photoId, jobId, submittedAt: new Date().toISOString(), room: p.room, style: p.style, error: jobId ? null : JSON.stringify(tr.body).slice(0, 200) });
  console.log(jobId ? `submitted ${p.t.padEnd(9)} ${p.name} → ${jobId}` : `SUBMIT FAIL ${p.t} ${p.name}: ${jobs.at(-1).error}`);
  fs.writeFileSync('/tmp/validation-batch4.json', JSON.stringify({ jobs }, null, 1));
  await new Promise(r => setTimeout(r, 3000));
}
console.log(`\n${jobs.filter(j => j.jobId).length} submitted; polling…`);
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
  fs.writeFileSync('/tmp/validation-batch4.json', JSON.stringify({ jobs }, null, 1));
  console.log(`[${new Date().toISOString().slice(11,19)}] ${done}/${jobs.length} terminal` + (running.length ? ' — ' + running.slice(0,5).join('; ') : ''));
  if (done === jobs.length) break;
}
console.log('BATCH4 COMPLETE');
