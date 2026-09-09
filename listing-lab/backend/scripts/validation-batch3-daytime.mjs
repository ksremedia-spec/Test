#!/usr/bin/env node
/**
 * The 2pm daytime battery, batch 3 (2 Sep 2026, Kyle: "another set of unique
 * photos... we can test the pipeline and the generations at once"). All 20
 * photos are NEVER-TESTED originals, pre-uploaded on the probe account
 * (/tmp/b3-roster.json). Twilight has ZERO untested exteriors left in the
 * system: if Kyle uploaded fresh exteriors to HIS account after 2026-09-02T10:00Z
 * they are used for the 5 twilight slots; otherwise the 5 'spare' fresh
 * interiors run as extra declutters instead — 20 unique gens either way.
 */
import fs from 'node:fs';
const SITE = 'https://thelistinglab.app';
const COOKIE = JSON.parse(fs.readFileSync('/tmp/probe-session.json', 'utf8')).cookie;
const roster = JSON.parse(fs.readFileSync('/tmp/b3-roster.json', 'utf8'));

async function api(path, opts = {}) {
  const r = await fetch(SITE + path, { ...opts, headers: { cookie: COOKIE, ...(opts.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
}

// Twilight slots: fresh exteriors from Kyle's accounts uploaded after 10:00Z
// today (checked via the board's diag JSON is not available here — the
// launcher passes them in /tmp/b3-exteriors.json if found; see the wake-up
// instructions). Fallback: spares run as declutter.
let plan = roster.filter(r => r.t !== 'spare');
let ext = [];
try { ext = JSON.parse(fs.readFileSync('/tmp/b3-exteriors.json', 'utf8')); } catch {}
if (ext.length) {
  plan = plan.concat(ext.slice(0, 5).map((e, i) => ({ t: 'twilight', name: `b3-ext-${i+1}`, photoId: e.photoId })));
  console.log(`${ext.length} fresh exteriors from Kyle — twilight runs on them`);
} else {
  plan = plan.concat(roster.filter(r => r.t === 'spare').map(r => ({ ...r, t: 'declutter' })));
  console.log('no fresh exteriors uploaded — spares run as extra declutters');
}

const jobs = [];
for (const p of plan) {
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
  fs.writeFileSync('/tmp/validation-batch3.json', JSON.stringify({ jobs }, null, 1));
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
  fs.writeFileSync('/tmp/validation-batch3.json', JSON.stringify({ jobs }, null, 1));
  console.log(`[${new Date().toISOString().slice(11,19)}] ${done}/${jobs.length} terminal` + (running.length ? ' — ' + running.slice(0,5).join('; ') : ''));
  if (done === jobs.length) break;
}
console.log('BATCH3 COMPLETE');
