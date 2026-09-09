#!/usr/bin/env node
/**
 * Regression harness for structure.js.
 *   node structure-test.js                 # every case
 *   node structure-test.js --only kliv-bad
 * Each case declares the verdict we EXPECT, so a false positive on a good image
 * fails the run just as loudly as a miss on a bad one.
 */
const fs = require('fs'), path = require('path');
// same .env loader transform.js uses — no dependency, no-op if already set
try {
  const envFile = path.join(__dirname, '.env');
  if (!process.env.GEMINI_API_KEY && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}
const { locateFixed, verifyFixedElements, verifyFocalPoint } = require('./structure');
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.JUDGE_MODEL || 'gemini-3.6-flash';
const b64 = f => fs.readFileSync(f).toString('base64');
const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };

const CASES = [
  // the image Kyle caught: a window replaced by shiplap with a painting hung over it
  { id: 'kliv-bad',  before: 'k-living.jpg', after: 'out/round22/k-living.staging-Transitional-LivingRoom.approved.jpg', room: 'Living Room', expect: 'fail' },
  // Same room, same style, structurally clean — but Kyle reviewed this render on
  // 2026-08-23 and said the layout "shouldn't have been checked as a pass. It
  // doesn't properly pick the focal point." The sofa's back is to the fireplace.
  // Expected to FAIL on the focal-point gate and PASS every structural element.
  { id: 'kliv-good', before: 'k-living.jpg', after: 'out/bakeoff/nano.k-living.staging-Transitional-LivingRoom.approved.jpg', room: 'Living Room', expect: 'fail', expectReason: 'focal' },
  // The render that replaced the hero. Must pass BOTH gates before it ships.
  { id: 'kliv-hero', before: 'k-living.jpg', after: 'out/k-living.staging-Standard-LivingRoom.approved.jpg', room: 'Living Room', expect: 'pass' },
  { id: 'liv-coastal',  before: 'living.jpg',  after: 'out/bakeoff/nano.living.staging-Coastal-LivingRoom.approved.jpg', room: 'Living Room', expect: 'pass' },
  { id: 'liv-dining',   before: 'living.jpg',  after: 'out/bakeoff/nano.living.staging-Modern-DiningRoom.approved.jpg', room: 'Dining Room', expect: 'pass' },
  { id: 'liv-office',   before: 'living.jpg',  after: 'out/prebakeoff/living.staging-Modern-HomeOffice.approved.jpg', room: 'Home Office', expect: 'pass' },
  { id: 'kbed-lux',     before: 'k-bedroom.jpg', after: 'out/bakeoff/nano.k-bedroom.staging-Luxury-PrimaryBedroom.approved.jpg', room: 'Primary Bedroom', expect: 'pass' },
  { id: 'kbed-std',     before: 'k-bedroom.jpg', after: 'out/bakeoff/nano.k-bedroom.staging-Transitional-PrimaryBedroom.approved.jpg', room: 'Primary Bedroom', expect: 'pass' },
  { id: 'koff',         before: 'k-office.jpg', after: 'out/bakeoff/nano.k-office.staging-Transitional-HomeOffice.approved.jpg', room: 'Home Office', expect: 'pass' },
  { id: 'bed1-staged',  before: 'bedroom1-emptied.jpg', after: 'out/bedroom1-emptied.staging-Standard-PrimaryBedroom.approved.jpg', room: 'Primary Bedroom', expect: 'pass' },
  { id: 'bed2-staged',  before: 'bedroom2-emptied.jpg', after: 'out/bedroom2-emptied.staging-Transitional-Bedroom.approved.jpg', room: 'Guest Bedroom', expect: 'pass' },
  { id: 'bed2-empty',   before: 'bedroom2.jpg', after: 'out/bedroom2.empty.approved.jpg', room: null, expect: 'pass', noFocal: true },
  { id: 'bed1-declut',  before: 'bedroom1.jpg', after: 'out/prebakeoff/bedroom1.declutter.approved.jpg', room: null, expect: 'pass', noFocal: true },
];

(async () => {
  const only = arg('only');
  const cases = only ? CASES.filter(c => c.id === only) : CASES;
  const results = [];
  for (const c of cases) {
    const bPath = path.join(__dirname, c.before), aPath = path.join(__dirname, c.after);
    if (!fs.existsSync(bPath) || !fs.existsSync(aPath)) { console.log(`SKIP ${c.id} (missing file)`); continue; }
    const beforeBuf = fs.readFileSync(bPath), afterBuf = fs.readFileSync(aPath);
    const t0 = Date.now();
    const fixed = await locateFixed(KEY, MODEL, beforeBuf.toString('base64'), 'image/jpeg');
    const struct = await verifyFixedElements(KEY, MODEL, beforeBuf, afterBuf, fixed);
    let focal = { skipped: true };
    if (!c.noFocal) focal = await verifyFocalPoint(KEY, MODEL, beforeBuf.toString('base64'), 'image/jpeg', afterBuf.toString('base64'), 'image/jpeg', c.room, 3);
    const violations = [...struct.violations, ...(focal.violations || [])];
    const got = violations.length ? 'fail' : 'pass';
    const ok = got === c.expect;
    results.push({ id: c.id, expect: c.expect, got, ok, violations, checked: struct.checked, sec: ((Date.now() - t0) / 1000).toFixed(0) });
    console.log(`${ok ? '✓' : '✗'} ${c.id.padEnd(13)} expect ${c.expect}  got ${got}  (${struct.checked} elements, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    violations.forEach(v => console.log('      ✗ ' + v));
    if (focal.minor && focal.minor.length) focal.minor.forEach(v => console.log('      ~ ' + v));
    if (!ok) console.log('      details: ' + JSON.stringify(struct.details.filter(d => d.verdict !== 'present')).slice(0, 600));
    fs.writeFileSync(path.join(__dirname, 'out', `structure.${c.id}.json`), JSON.stringify({ fixed, struct, focal }, null, 2));
  }
  const pass = results.filter(r => r.ok).length;
  console.log(`\n${pass}/${results.length} cases behaved as expected`);
  const misses = results.filter(r => !r.ok);
  if (misses.length) console.log('MISBEHAVING: ' + misses.map(m => `${m.id} (expected ${m.expect}, got ${m.got})`).join(', '));
})();
