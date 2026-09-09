#!/usr/bin/env node
// Poller for the already-submitted 20-job validation batch (jobs API key is jobId).
import fs from 'node:fs';
const SITE = 'https://thelistinglab.app';
const COOKIE = JSON.parse(fs.readFileSync('/tmp/probe-session.json', 'utf8')).cookie;
const state = JSON.parse(fs.readFileSync('/tmp/validation-batch.json', 'utf8'));
const terminal = new Set(['delivered', 'rejected', 'failed']);
for (let tick = 0; tick < 240; tick++) {
  const r = await fetch(SITE + '/api/jobs', { headers: { cookie: COOKIE } });
  const list = (await r.json()).jobs || [];
  const byId = {}; for (const j of list) byId[j.jobId] = j;
  let done = 0; const running = [];
  for (const rec of state.jobs) {
    const j = byId[rec.jobId];
    if (!j) { done++; continue; }
    rec.live = { status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt || null, note: j.note || null, waits: j.waitingOnUpstream };
    if (terminal.has(j.status)) done++; else running.push(`${rec.t}/${rec.name}:${j.status}`);
  }
  fs.writeFileSync('/tmp/validation-batch.json', JSON.stringify(state, null, 1));
  console.log(`[${new Date().toISOString().slice(11,19)}] ${done}/${state.jobs.length} terminal` + (running.length ? ' — ' + running.slice(0,5).join('; ') : ''));
  if (done === state.jobs.length) break;
  await new Promise(res => setTimeout(res, 30000));
}
console.log('POLL COMPLETE');
