#!/usr/bin/env node
/**
 * Gate on the DEMO photography, not just on customer output.
 *
 * On 2026-08-23 a staged render was shipped as the artifact hero after the
 * structural checker had already failed it on focal-point orientation. The check
 * ran, the result was written down, and the image shipped anyway — because nothing
 * stood between "an asset file" and "an asset in the build". This is that thing.
 *
 *   node verify-artifact-photos.js --manifest /tmp/build/assets.js
 *
 * Every before/after pair declared in the artifact's asset map is run through the
 * same gates a customer job goes through. Exit code 1 if any pair fails, so the
 * build cannot proceed on an image the pipeline itself would reject.
 */
const fs = require('fs'), path = require('path');
try {
  const envFile = path.join(__dirname, '.env');
  if (!process.env.GEMINI_API_KEY && fs.existsSync(envFile))
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
} catch {}
const { locateFixed, verifyFixedElements, verifyFocalPoint } = require('./structure');
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.JUDGE_MODEL || 'gemini-3.6-flash';

/* Which asset is the "before" for each generated asset, and what room it claims to
   be. Anything absent here is an original photograph and needs no verification. */
const PAIRS = {
  'liv.coastal':  { before: 'liv.day',    room: 'Living Room' },
  'liv.dining':   { before: 'liv.day',    room: 'Dining Room' },
  'liv.office':   { before: 'liv.day',    room: 'Home Office' },
  'bed1.declut':  { before: 'bed1.occ',   room: null },
  'bed1.empty':   { before: 'bed1.occ',   room: null },
  'bed1.staged':  { before: 'bed1.empty', room: 'Primary Bedroom' },
  'bed2.declut':  { before: 'bed2.occ',   room: null },
  'bed2.empty':   { before: 'bed2.occ',   room: null },
  'bed2.staged':  { before: 'bed2.empty', room: 'Guest Bedroom' },
  'kliv.staged':  { before: 'kliv.empty', room: 'Living Room' },
  'kbed.std':     { before: 'kbed.empty', room: 'Primary Bedroom' },
  'kbed.lux':     { before: 'kbed.empty', room: 'Primary Bedroom' },
  'koff.staged':  { before: 'koff.empty', room: 'Home Office' },
  // twilight is graded by the exterior rules, not by interior fixed-element crops
};
/* bed1.staged / bed2.staged are chained off an emptied frame; the emptied file the
   generator actually consumed is the raw, not the watermarked delivery. */
const RAW_FOR = { 'bed1.empty': 'bedroom1-emptied.jpg', 'bed2.empty': 'bedroom2-emptied.jpg' };

function readMap(manifestPath) {
  const src = fs.readFileSync(manifestPath, 'utf8');
  const body = src.slice(src.indexOf('const MAP'), src.indexOf('};', src.indexOf('const MAP')));
  const map = {};
  for (const m of body.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) map[m[1]] = m[2];
  return map;
}

(async () => {
  const i = process.argv.indexOf('--manifest');
  const manifest = i > -1 ? process.argv[i + 1] : '/tmp/build/assets.js';
  const MAP = readMap(manifest);
  const rows = [];
  for (const [after, spec] of Object.entries(PAIRS)) {
    if (!MAP[after] || !MAP[spec.before]) { console.log(`SKIP ${after} (not in manifest)`); continue; }
    const beforeFile = path.join(__dirname, RAW_FOR[spec.before] || MAP[spec.before]);
    const afterFile = path.join(__dirname, MAP[after]);
    if (!fs.existsSync(beforeFile) || !fs.existsSync(afterFile)) { console.log(`SKIP ${after} (file missing)`); continue; }
    const beforeBuf = fs.readFileSync(beforeFile), afterBuf = fs.readFileSync(afterFile);
    const fixed = await locateFixed(KEY, MODEL, beforeBuf.toString('base64'), 'image/jpeg');
    const el = await verifyFixedElements(KEY, MODEL, beforeBuf, afterBuf, fixed);
    let focal = { skipped: true, reason: 'not a staging asset' };
    if (spec.room) focal = await verifyFocalPoint(KEY, MODEL, beforeBuf.toString('base64'), 'image/jpeg', afterBuf.toString('base64'), 'image/jpeg', spec.room, 3);
    const violations = [...el.violations, ...(focal.violations || [])];
    rows.push({ after, violations });
    console.log(`${violations.length ? '✗' : '✓'} ${after.padEnd(13)} ${el.checked} features` +
      (focal.skipped ? ', focal n/a' : `, focal ${JSON.stringify(focal.tally)}`));
    violations.forEach(v => console.log('      ✗ ' + v));
  }
  const bad = rows.filter(r => r.violations.length);
  fs.writeFileSync(path.join(__dirname, 'out', 'artifact-photo-verification.json'), JSON.stringify(rows, null, 2));
  if (bad.length) {
    console.error(`\nBUILD BLOCKED — ${bad.length} artifact photo(s) fail the same gates a customer job would: ${bad.map(b => b.after).join(', ')}`);
    process.exit(1);
  }
  console.log(`\nAll ${rows.length} generated artifact photos pass. Safe to publish.`);
})();
