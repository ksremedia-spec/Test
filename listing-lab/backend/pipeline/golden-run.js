#!/usr/bin/env node
/**
 * Listing Lab — golden-set regression runner.
 *   node golden-run.js                 # run all cases
 *   node golden-run.js --type staging  # one transformation
 *   node golden-run.js --votes 1       # faster, noisier
 * Compares the judge's verdict to the human-graded expectation in golden/manifest.json
 * and writes golden/last-run.json. Exit code 1 if any case flips.
 */
const fs = require('fs'); const path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
const { judgeComplianceVoted } = require('./compliance');
const { frameLock, frameScore } = require('./framelock');
const { reviewRegions } = require('./regionreview');
const { geminiGenerateContent } = require('./gemini');
const { gatingClutterLine } = require('./scope');
const { scoreCandidate } = require('./rank');
const MIN_SCORE = parseFloat(process.env.MIN_DESIGN_SCORE || '6');
const { analyzeLayout } = require('./layout');
const { inventoryRoom, inventoryFixed } = require('./inventory');
const { applianceCensus, verifyAppliances } = require('./appliancecheck');
// THE TEARDOWN (2 Sep 2026): the harness mirrors the pipeline, and the
// pipeline is one judge + instruments now. Structure/focal/realism gates are
// gone from both; twilight and staging keep the quality score (a chooser).
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const MODEL = process.env.JUDGE_MODEL || 'gemini-3.6-flash';
const VOTES = parseInt(arg('votes', '2'), 10);
const onlyType = arg('type');
// --ids c002,c087 runs just those cases — for verifying a regrade or a rule
// change cheaply before paying for the full set.
const onlyIds = arg('ids') ? new Set(arg('ids').split(',')) : null;
const b64 = f => fs.readFileSync(f).toString('base64');
const mime = f => /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';

(async () => {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden/manifest.json')));
  const cases = man.cases.filter(c => !onlyType || c.type === onlyType)
    .filter(c => !onlyIds || onlyIds.has(c.id))
    .filter(c => c.expected === 'pass' || c.expected === 'fail');
  const prev = fs.existsSync('golden/last-run.json') ? JSON.parse(fs.readFileSync('golden/last-run.json')) : null;
  // cache per-original analysis (layout / inventory) so the judge gets the same context the pipeline gives it
  const ctx = {};
  const results = [];
  const CONC = parseInt(arg('concurrency', '4'), 10);
  // pre-compute per-original context sequentially (cheap, cached)
  for (const c of cases) {
    const o = b64(c.original);
    if (c.type === 'staging') ctx[c.original + '|L|' + c.room] ??= await analyzeLayout(process.env.GEMINI_API_KEY, o, mime(c.original), MODEL, c.room);
    if (c.type === 'declutter') ctx[c.original + '|I'] ??= await inventoryRoom(process.env.GEMINI_API_KEY, o, mime(c.original), MODEL);
    if (c.type === 'empty') ctx[c.original + '|E'] ??= await inventoryFixed(process.env.GEMINI_API_KEY, o, mime(c.original), MODEL);
    // The appliance census, exactly as transform.js takes it — once per original.
    if (c.type !== 'twilight' && process.env.APPLIANCE_CHECK === '1' && ctx[c.original + '|A'] === undefined) {
      try { ctx[c.original + '|A'] = await applianceCensus(process.env.GEMINI_API_KEY, MODEL, o, mime(c.original)); } catch { ctx[c.original + '|A'] = []; }
    }
    // Clutter regions for the close-up review (declutter only) — the same
    // detection the masked path runs, cached per original.
    if (c.type === 'declutter' && ctx[c.original + '|R'] === undefined) {
      try {
        const j = await geminiGenerateContent(process.env.GEMINI_API_KEY, MODEL, {
          contents: [{ role: 'user', parts: [
            { text: `List every item of PERSONAL CLUTTER visible in this room photo that belongs to this list: ${gatingClutterLine()}.\nOutput a JSON list where each entry contains the 2D bounding box in the key "box_2d" ([ymin, xmin, ymax, xmax] normalized 0-1000) and a short descriptive text label in the key "label". If there is no clutter, output [].` },
            { inline_data: { mime_type: mime(c.original), data: o } }] }],
          generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
        });
        const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
        ctx[c.original + '|R'] = JSON.parse(txt).filter(r => Array.isArray(r.box_2d) && r.box_2d.length === 4);
      } catch { ctx[c.original + '|R'] = null; }
    }
  }
  const queue = [...cases];
  const worker = async () => { while (queue.length) { const c = queue.shift(); await runCase(c); } };
  async function runCase(c) {
    const o = b64(c.original), cand = b64(c.candidate);
    let inventory;
    if (c.type === 'staging') inventory = { ...ctx[c.original + '|L|' + c.room], roomType: c.room };
    if (c.type === 'declutter') inventory = ctx[c.original + '|I'];
    if (c.type === 'empty') inventory = ctx[c.original + '|E'];
    // THE FRAME LOCK runs first on twilight, exactly as in transform.js —
    // deterministic edge alignment; a re-imagined frame dies before judging.
    let fl = null;
    if (c.type === 'twilight') {
      try { fl = await frameLock(Buffer.from(o, 'base64'), Buffer.from(cand, 'base64')); } catch {}
    } else if (c.type === 'staging') {
      // Staging edition — its own conservative threshold (see transform.js).
      const min = parseFloat(process.env.FRAMELOCK_MIN_STAGING || '0.32');
      try {
        const s = await frameScore(Buffer.from(o, 'base64'), Buffer.from(cand, 'base64'));
        fl = { ...s, ok: min <= 0 || s.score >= min, min };
      } catch {}
    }
    let v;
    if (fl && !fl.ok) {
      v = { pass: false, passes: 0, votes: 0, violations: [`frame lock: edge alignment ${fl.score} < ${fl.min} — a different photograph of the property`] };
    } else {
      try { v = await judgeComplianceVoted(process.env.GEMINI_API_KEY, c.type, o, mime(c.original), cand, mime(c.candidate), MODEL, inventory, VOTES); }
      catch (e) { v = { pass: null, violations: ['judge error: ' + e.message.slice(0, 80)] }; }
    }
    // The appliance roll call mirrors transform.js: on a pass, every censused
    // appliance must still be there up close (Kyle, 3 Sep 2026).
    let appliances = null;
    const census = ctx[c.original + '|A'] || [];
    if (v.pass && census.length) {
      try {
        appliances = await verifyAppliances(process.env.GEMINI_API_KEY, MODEL, Buffer.from(o, 'base64'), Buffer.from(cand, 'base64'), census);
        if (!appliances.ok) { v.pass = false; v.violations = (v.violations || []).concat(appliances.missing.map(t => 'appliance roll call: ' + t)); }
      } catch (e) { appliances = { error: e.message.slice(0, 80) }; }
    }
    // Ship decision since the teardown: the ONE judge decides; staging and
    // twilight additionally need the quality score >= MIN_SCORE (a chooser the
    // pipeline consults only on passes).
    let q = null, realism = null, structure = null;
    // Staging's design-score gate is gone (2 Sep 2026): on Kyle's grades it
    // was anti-correlated — his passes scored 3-4, his fails 7-8. Twilight
    // keeps its quality floor.
    if (v.pass && c.type === 'twilight') {
      try { q = await scoreCandidate(process.env.GEMINI_API_KEY, MODEL, o, mime(c.original), { data: cand, mime: mime(c.candidate) }, c.type, c.room, c.style, c.candidate); } catch (e) { q = { score: null, reason: e.message }; }
      // THE UGLY FLOOR (Kyle, 2 Sep 2026) — mirror of transform.js: his ugly
      // fails score 1–4, his passes 8–9; below the floor a pass becomes a fail.
      const floor = parseFloat(process.env.TWILIGHT_SCORE_FLOOR || '5');
      if (q && q.score !== null && q.score < floor) {
        v = { ...v, pass: false, violations: (v.violations || []).concat([`quality ${q.score} below floor ${floor}`]) };
      }
    }
    /**
     * THE REGION CLOSE-UP REVIEW (3 Sep 2026) — mirror of the masked path in
     * transform.js: a declutter that passed the whole-frame judge gets its
     * clutter regions inspected up close, where the ghost that started all
     * this fills the frame instead of hiding in a bedroom. Benched 4/4 on
     * Kyle's graded triple. REGION_REVIEW=0 disables, as in production.
     */
    if (v.pass && c.type === 'declutter' && process.env.REGION_REVIEW !== '0') {
      const regs = ctx[c.original + '|R'];
      if (regs && regs.length) {
        try {
          const rr = await reviewRegions(process.env.GEMINI_API_KEY, MODEL, Buffer.from(o, 'base64'), Buffer.from(cand, 'base64'), regs);
          if (!rr.ok) v = { ...v, pass: false, violations: (v.violations || []).concat(rr.residue.map(t => 'close-up: ' + t).slice(0, 3)) };
        } catch { /* review unavailable — the whole-frame verdict stands */ }
      }
    }
    const got = v.pass === null ? 'error' : v.pass ? 'pass' : 'fail';
    const ok = got === c.expected;
    const was = prev && prev.results.find(r => r.id === c.id);
    const flip = was && was.ok !== ok ? (ok ? 'FIXED' : 'BROKE') : '';
    results.push({ id: c.id, type: c.type, expected: c.expected, got, ok, realism: realism && realism.worst, structure, score: q && q.score, votes: v.passes !== undefined ? `${v.passes}/${v.votes}` : '', violations: (v.violations || []).slice(0, 2), note: c.note, candidate: c.candidate });
    console.log(`${ok ? ' ok ' : ' XX '} ${c.id} ${c.type.padEnd(9)} expected ${c.expected.padEnd(4)} got ${got.padEnd(5)} ${v.passes !== undefined ? `(${v.passes}/${v.votes})` : ''}${q && q.score !== null ? ` score ${q.score}` : ''} ${flip}${!ok && v.violations && v.violations[0] ? ' — ' + v.violations[0].slice(0, 90) : ''}`);
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));
  const byType = {};
  for (const r of results) { byType[r.type] ??= { n: 0, ok: 0 }; byType[r.type].n++; if (r.ok) byType[r.type].ok++; }
  const total = results.length, okN = results.filter(r => r.ok).length;
  console.log(`\nSCORE ${okN}/${total}  ` + Object.entries(byType).map(([t, s]) => `${t} ${s.ok}/${s.n}`).join('  '));
  const falseRejects = results.filter(r => r.expected === 'pass' && r.got === 'fail').length;
  const falseAccepts = results.filter(r => r.expected === 'fail' && r.got === 'pass').length;
  console.log(`false rejects (good image failed): ${falseRejects}   false accepts (bad image passed): ${falseAccepts}`);
  if (prev) { const b = results.filter(r => { const w = prev.results.find(p => p.id === r.id); return w && w.ok && !r.ok; }); if (b.length) console.log('BROKE since last run: ' + b.map(r => r.id).join(', ')); }
  fs.writeFileSync('golden/last-run.json', JSON.stringify({ at: new Date().toISOString(), model: MODEL, votes: VOTES, score: { ok: okN, total }, results }, null, 2));
  process.exit(okN === total ? 0 : 1);
})();
