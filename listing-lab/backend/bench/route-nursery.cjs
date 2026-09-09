/**
 * Bench: does the coverage router send Kyle's nursery declutter down the
 * masked path? (2 Sep 2026 — the scene classifier once called this room "too
 * full"; the router must not repeat that mistake.)
 *
 * Run from anywhere: node /home/claude/backend/bench/route-nursery.js [photo]
 */
const fs = require('fs');
const path = require('path');
// Load the backend .env the same way the pipeline does on the bench.
for (const line of fs.readFileSync(path.join(__dirname, '..', 'pipeline', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const maskedit = require(path.join(__dirname, '..', 'pipeline', 'maskedit.js'));
const { geminiGenerateContent, setDeadline } = require(path.join(__dirname, '..', 'pipeline', 'gemini.js'));
const { clutterLine, keeperLine } = require(path.join(__dirname, '..', 'pipeline', 'scope.js'));

const MAX_PCT = parseFloat(process.env.MASKED_FIRST_MAX_PCT || '25');
const MAX_REGION_PCT = parseFloat(process.env.MASKED_FIRST_MAX_REGION_PCT || '8');

(async () => {
  setDeadline(Date.now() + 240_000);
  const photo = process.argv[2] || '/tmp/nur-orig.jpg';
  const b64 = fs.readFileSync(photo).toString('base64');
  const model = process.env.SEG_MODEL || process.env.JUDGE_MODEL || 'gemini-3.6-flash';
  const t0 = Date.now();
  const regions = await maskedit.detectAndTrace(
    { geminiGenerateContent }, process.env.GEMINI_API_KEY, model, b64, 'image/jpeg', clutterLine(), keeperLine());
  console.log(`segmented ${regions.length} region(s) (${regions.filter(r => r.polygons).length} traced) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const r of regions) {
    const c1 = maskedit.coverage([r]);
    console.log(`  · ${String(r.label).slice(0, 70)}  ${r.polygons ? c1.unionPct + '%' : '(untraced)'}`);
  }
  const cov = maskedit.coverage(regions);
  const small = cov.unionPct <= MAX_PCT && cov.largestPct <= MAX_REGION_PCT;
  console.log(`\ncoverage: union ${cov.unionPct}% (limit ${MAX_PCT}%) · largest ${cov.largestPct}% "${cov.largestLabel}" (limit ${MAX_REGION_PCT}%)`);
  console.log(`ROUTE → ${small ? 'MASKED leads' : 'classic leads'}`);
})().catch(e => { console.error('BENCH FAILED: ' + e.message); process.exit(1); });
