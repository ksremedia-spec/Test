#!/usr/bin/env node
/**
 * Run externally produced candidates (e.g. VSAI renders downloaded from their app) through the
 * identical Listing Lab decision: layout analysis, 3-vote compliance judge, head-stager ranking,
 * design-score gate, watermark. Writes the same audit JSON transform.js writes, so bakeoff.js,
 * source-report.js and the golden set treat them as first-class.
 *
 *   node judge-manual.js --input k-living.jpg --room "Living Room" --style Transitional \
 *        --source vsai --candidates manual/1-a.jpg,manual/1-b.jpg,manual/1-c.jpg
 */
const fs = require('fs'); const path = require('path');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
const { judgeComplianceVoted } = require('./compliance'); const { analyzeLayout } = require('./layout');
const { rankCandidates } = require('./rank'); const { applyWatermark, verifyWatermark } = require('./watermark'); const { WATERMARK_TEXT, ROOM_TYPES } = require('./prompts');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const MODEL = process.env.JUDGE_MODEL || 'gemini-3.6-flash', VOTES = parseInt(process.env.JUDGE_VOTES || '3', 10), MIN = parseFloat(process.env.MIN_DESIGN_SCORE || '6');
const mime = f => /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
(async () => {
  const input = arg('input'), room = arg('room'), style = arg('style'), source = arg('source', 'manual');
  const files = (arg('candidates') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!input || !room || !style || !files.length) { console.error('need --input --room --style --candidates a.jpg,b.jpg'); process.exit(1); }
  if (!ROOM_TYPES[room]) { console.error('unknown room: ' + room); process.exit(1); }
  const key = process.env.GEMINI_API_KEY; const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
  const stem = path.basename(input).replace(/\.[^.]+$/, ''); const tag = ['staging', style, room].join('-').replace(/\s+/g, '');
  const oB64 = fs.readFileSync(input).toString('base64');
  const audit = { input, type: 'staging', options: { style, room }, source, judgeModel: MODEL, judgeVotes: VOTES, attempts: [], startedAt: new Date().toISOString() };
  console.log('— Analysing layout…'); const layout = await analyzeLayout(key, oB64, mime(input), MODEL, room); layout.roomType = room; audit.layout = layout;
  const cands = [];
  await Promise.all(files.map(async (f, i) => {
    const n = i + 1; const data = fs.readFileSync(f).toString('base64');
    const raw = path.join(OUT, `${stem}.${tag}.cand${n}.${source}.raw.jpg`); fs.copyFileSync(f, raw);
    const verdict = await judgeComplianceVoted(key, 'staging', oB64, mime(input), data, mime(f), MODEL, layout, VOTES);
    console.log(`  cand ${n} [${source}]: ${verdict.pass ? 'PASS' : 'FAIL'} (${verdict.passes}/${verdict.votes})` + (verdict.violations[0] ? ' — ' + verdict.violations[0].slice(0, 110) : ''));
    audit.attempts.push({ round: 1, candidate: n, source, raw, verdict }); cands.push({ n, gen: { data, mime_type: mime(f) }, verdict, source });
  }));
  const compliant = cands.filter(c => c.verdict.pass).sort((a, b) => a.n - b.n);
  console.log(`  ${compliant.length}/${cands.length} compliant`);
  if (compliant.length) {
    const rank = await rankCandidates(key, MODEL, oB64, mime(input), compliant.map(c => c.gen), room, style);
    const ordered = rank.order.map(i => compliant[i]); audit.ranking = { round: 1, order: ordered.map(c => c.n), scores: rank.scores, reasons: rank.reasons };
    ordered.forEach((c, i) => console.log(`  #${i + 1}: cand ${c.n} — score ${rank.scores[rank.order[i]] ?? '?'} — ${rank.reasons[String(rank.order[i] + 1)] || ''}`));
    const bestScore = rank.scores[rank.order[0]];
    if (bestScore === undefined || bestScore >= MIN) {
      const wm = WATERMARK_TEXT.staging; const buf = await applyWatermark(Buffer.from(ordered[0].gen.data, 'base64'), wm); const chk = await verifyWatermark(buf, wm);
      const outPath = path.join(OUT, `${stem}.${tag}.approved.jpg`); fs.writeFileSync(outPath, buf); audit.delivered = outPath; audit.deliveredCandidate = ordered[0].n; audit.deliveredSource = source; audit.watermark = { text: wm, ...chk };
      if (ordered[1]) { const alt = path.join(OUT, `${stem}.${tag}.alternate.jpg`); fs.writeFileSync(alt, await applyWatermark(Buffer.from(ordered[1].gen.data, 'base64'), wm)); audit.alternate = alt; }
      console.log(`APPROVED → ${outPath}`);
    } else console.log(`best design score ${bestScore} < ${MIN} — REJECTED`);
  } else console.log('REJECTED — no compliant candidate');
  audit.finishedAt = new Date().toISOString(); audit.outcome = audit.delivered ? 'approved' : 'rejected';
  fs.writeFileSync(path.join(OUT, `${stem}.${tag}.audit.json`), JSON.stringify(audit, null, 2));
})();
