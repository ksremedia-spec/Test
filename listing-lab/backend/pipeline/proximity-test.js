#!/usr/bin/env node
/**
 * Listing Lab — false-positive run for the focal-point PROXIMITY check.
 *
 *   node proximity-test.js
 *   node proximity-test.js --only coastal-approved
 *
 * WHAT THIS IS FOR
 * The golden-set README states the rule this harness enforces: "A false positive on
 * a case Kyle passed is a worse failure than missing a defect, because it means the
 * product rejects work he considers deliverable."
 *
 * So the MUST-PASS block below is the real test. Every image in it is one Kyle has
 * personally approved — including the Coastal great room he passed on 2026-08-25
 * while saying he wished it were closer to the fireplace. "Further than I'd like"
 * is not "reject it", and if this check cannot tell those apart it must not ship.
 *
 * The REPORT-ONLY block carries no expectation on purpose. Kyle's notes on those
 * rejects talk about orientation, not distance; declaring them distance failures
 * would be inventing his reasoning. They are printed so a human can read what the
 * check says and decide.
 *
 * Exit code is 1 if any MUST-PASS image is marooned.
 */
const fs = require('fs'), path = require('path');
try {
  const envFile = path.join(__dirname, '.env');
  if (!process.env.GEMINI_API_KEY && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}
const { verifyFocalProximity } = require('./structure');
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.JUDGE_MODEL || 'gemini-3.6-flash';
const VOTES = parseInt(process.env.FOCAL_VOTES || '3', 10);
const b64 = f => fs.readFileSync(f).toString('base64');
const arg = n => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };

const ORIGINAL = 'k-living.jpg';

/* Kyle has approved every one of these. None may come back "marooned". */
const MUST_PASS = [
  { id: 'coastal-approved', after: 'out/k-living.staging-Coastal-LivingRoom.approved.jpg',
    why: 'Kyle 2026-08-25: "Coastal is good" — while wishing it sat closer. The calibration case.' },
  { id: 'hero-standard', after: 'out/k-living.staging-Standard-LivingRoom.approved.jpg',
    why: 'The published hero. Passes structure and focal 3/3.' },
  { id: 'luxury-approved', after: 'out/k-living.staging-Luxury-LivingRoom.approved.jpg',
    why: 'New batch, faces focal 3/3, Kyle raised no objection.' },
  { id: 'modern-approved', after: 'out/k-living.staging-Modern-LivingRoom.approved.jpg',
    why: 'New batch, faces focal 2/3, Kyle raised no objection.' },
];

/* No expectation declared — printed for a human to read. */
const REPORT_ONLY = [
  { id: 'v2-cand1', after: 'out/k-living.staging-Coastal-LivingRoom.cand1.nano.raw.jpg',
    why: 'After the "pull it in" prompt change. Looks unchanged to me — sofa still on the window wall.' },
  { id: 'v2-cand2', after: 'out/k-living.staging-Coastal-LivingRoom.cand2.nano.raw.jpg',
    why: 'After the prompt change. This is the one that visibly pulled in.' },
  { id: 'v2-cand3', after: 'out/k-living.staging-Coastal-LivingRoom.cand3.nano.raw.jpg',
    why: 'After the prompt change. Looks unchanged to me.' },
  { id: 'golden-c009', after: 'golden/images/c009_k-living.staging-Transitional-LivingRoom.cand1.raw.jpg',
    why: 'Kyle failed this one. His note is about orientation, not distance.' },
  { id: 'golden-c053', after: 'golden/images/c053_k-living.staging-Transitional-LivingRoom.attempt1.raw.jpg',
    why: 'Kyle failed this one. "bad placement ... does not face fireplace".' },
  { id: 'back-to-fire', after: 'out/bakeoff/nano.k-living.staging-Transitional-LivingRoom.approved.jpg',
    why: 'The sofa with its back to the fireplace — but sitting right on top of it. Should read as gathered.' },
];

(async () => {
  const only = arg('only');
  const pick = list => list.filter(c => !only || c.id === only);
  const origPath = path.join(__dirname, ORIGINAL);
  if (!fs.existsSync(origPath)) { console.error(`missing original ${ORIGINAL}`); process.exit(2); }
  const orig = b64(origPath);

  let failures = 0;

  const run = async (c, enforce) => {
    const p = path.join(__dirname, c.after);
    if (!fs.existsSync(p)) { console.log(`  SKIP ${c.id.padEnd(18)} (missing ${c.after})`); return; }
    const t0 = Date.now();
    let r;
    try { r = await verifyFocalProximity(KEY, MODEL, orig, 'image/jpeg', b64(p), 'image/jpeg', 'Living Room', VOTES); }
    catch (e) { console.log(`  ERR  ${c.id.padEnd(18)} ${e.message.slice(0, 90)}`); return; }
    const secs = Math.round((Date.now() - t0) / 1000);
    if (r.skipped) { console.log(`  --   ${c.id.padEnd(18)} skipped: ${r.reason} (${secs}s)`); return; }
    const bad = r.violations.length > 0;
    const gap = r.medianGapFeet !== null ? `~${r.medianGapFeet}ft` : 'no estimate';
    const tally = JSON.stringify(r.tally);
    if (enforce && bad) {
      failures++;
      console.log(`  FAIL ${c.id.padEnd(18)} MAROONED an image Kyle approved  ${tally} ${gap} (${secs}s)`);
      console.log(`         ${r.violations[0]}`);
    } else if (enforce) {
      console.log(`  ok   ${c.id.padEnd(18)} not marooned  ${tally} ${gap} (${secs}s)`);
    } else {
      console.log(`  ${bad ? 'MAROONED' : 'gathered'.padEnd(8)} ${c.id.padEnd(18)} ${tally} ${gap} (${secs}s)`);
      if (bad) console.log(`         ${r.violations[0]}`);
    }
  };

  const mustPass = pick(MUST_PASS), reportOnly = pick(REPORT_ONLY);

  if (mustPass.length) {
    console.log('\nMUST PASS — images Kyle has approved. A failure here blocks the check from shipping.\n');
    for (const c of mustPass) await run(c, true);
  }
  if (reportOnly.length) {
    console.log('\nREPORT ONLY — no expectation declared. Read and decide.\n');
    for (const c of reportOnly) await run(c, false);
  }

  console.log('');
  if (failures) {
    console.log(`${failures} approved image(s) rejected by the proximity check — DO NOT enable PROXIMITY_GATE.`);
    process.exit(1);
  }
  console.log('No approved image was rejected — the check clears the false-positive bar.');
  console.log('That is NOT the same as the check working. Read the REPORT ONLY block: if it');
  console.log('flags the candidate a human judged closest, its distance estimate is measuring');
  console.log('camera depth rather than the defect, and PROXIMITY_GATE must stay off.');
})();
