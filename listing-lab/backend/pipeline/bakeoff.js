#!/usr/bin/env node
/**
 * Listing Lab — generator bake-off: Nano Banana pipeline vs Virtual Staging AI.
 *
 *   node bakeoff.js --rooms rooms.json            # run both sources on every room
 *   node bakeoff.js --rooms rooms.json --only vsai  # (or nano) re-run one side
 *   node bakeoff.js --rooms rooms.json --manual manual/   # VSAI renders downloaded by hand from the app:
 *        manual/<N>-*.jpg  where N = 1-based index of the room in rooms.json (up to 3 files per N)
 *
 * rooms.json: [{ "input": "k-living.jpg", "room": "Living Room", "style": "Transitional" }, ...]
 *
 * For each room and each source, runs the full staging pipeline (3 candidates, 3-vote
 * judge, head-stager ranking, design score) via transform.js with STAGING_SOURCES set,
 * then writes:
 *   out/bakeoff/<room>.<source>.approved.jpg   delivered pick (or nothing if rejected)
 *   out/bakeoff/<room>.sidebyside.jpg          original | nano | vsai
 *   out/bakeoff/scorecard.json + scorecard.md  compliance rate, design scores, cost, time
 *   out/bakeoff/GRADE-ME.html                  blind grading sheet (sources hidden, A/B shuffled)
 * Grade it, paste the JSON back, and `node bakeoff.js --apply grades.json` prints the winner.
 */
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const sharp = require('sharp'); const crypto = require('crypto');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const OUT = path.join(__dirname, 'out'); const BK = path.join(OUT, 'bakeoff'); fs.mkdirSync(BK, { recursive: true });
const SOURCES = { nano: 'nano,nano,nano', vsai: 'vsai,vsai,vsai' };
const MANUAL = arg('manual');
const VSAI_PHOTO_COST = parseFloat(process.env.VSAI_MONTHLY || '139') / 150, NANO_GEN_COST = process.env.IMAGE_SIZE === '4K' ? 0.24 : 0.134, FLASH_CALL = 0.008;

function tagFor(r) { return ['staging', r.style, r.room].filter(Boolean).join('-').replace(/\s+/g, ''); }
function stem(f) { return path.basename(f).replace(/\.[^.]+$/, ''); }

async function sideBySide(files, outPath, w = 900) {
  const imgs = []; for (const f of files) { if (f && fs.existsSync(f)) imgs.push(await sharp(f).resize({ width: w }).toBuffer()); else imgs.push(await sharp({ create: { width: w, height: Math.round(w * 2 / 3), channels: 3, background: '#222' } }).jpeg().toBuffer()); }
  const metas = await Promise.all(imgs.map(b => sharp(b).metadata())); const h = Math.max(...metas.map(m => m.height));
  await sharp({ create: { width: w * imgs.length, height: h, channels: 3, background: '#111' } }).composite(imgs.map((b, i) => ({ input: b, left: i * w, top: 0 }))).jpeg({ quality: 85 }).toFile(outPath);
}

if (arg('apply')) {
  const g = JSON.parse(fs.readFileSync(arg('apply'))); const key = JSON.parse(fs.readFileSync(path.join(BK, 'blind-key.json')));
  const tally = { nano: 0, vsai: 0, tie: 0 };
  for (const [room, pick] of Object.entries(g)) { const k = key[room]; if (!k) continue; if (pick === 'tie' || pick === 'neither') tally.tie++; else tally[k[pick]]++; }
  console.log('Your blind picks →', tally); process.exit(0);
}

async function manualVsai(r, idx) {
  // Hand-downloaded VSAI renders → identical judge / ranking / design score / watermark via judge-manual.js
  const files = fs.readdirSync(MANUAL).filter(f => new RegExp(`^${idx}-.*\\.(jpe?g|png)$`, 'i').test(f)).slice(0, 3).map(f => path.join(MANUAL, f));
  if (!files.length) { console.error(`  no files ${idx}-*.jpg in ${MANUAL} for ${r.input}`); return; }
  try { execFileSync('node', ['judge-manual.js', '--input', r.input, '--room', r.room, '--style', r.style, '--source', 'vsai', '--candidates', files.join(',')], { cwd: __dirname, env: process.env, encoding: 'utf8', stdio: 'inherit' }); }
  catch (e) { console.error('  judge-manual failed: ' + (e.message || '').slice(0, 120)); }
}
(async () => {
  const rooms = JSON.parse(fs.readFileSync(arg('rooms')));
  const only = arg('only'); const card = [];
  for (const r of rooms) {
    const row = { room: r.input, roomType: r.room, style: r.style, sources: {} };
    for (const [src, spec] of Object.entries(SOURCES)) {
      if (only && only !== src) continue;
      const t0 = Date.now();
      if (src === 'vsai' && MANUAL) { await manualVsai(r, rooms.indexOf(r) + 1); }
      else {
      let log = '';
      try { log = execFileSync('node', ['transform.js', '--input', r.input, '--type', 'staging', '--style', r.style, '--room', r.room], { cwd: __dirname, env: { ...process.env, STAGING_SOURCES: spec }, encoding: 'utf8', maxBuffer: 1 << 26 }); }
      catch (e) { log = (e.stdout || '') + (e.stderr || ''); }
      }
      const sec = (Date.now() - t0) / 1000;
      const auditPath = path.join(OUT, `${stem(r.input)}.${tagFor(r)}.audit.json`);
      const audit = fs.existsSync(auditPath) ? JSON.parse(fs.readFileSync(auditPath)) : { attempts: [] };
      const cands = audit.attempts.length, compliant = audit.attempts.filter(a => a.verdict?.pass).length, errors = audit.attempts.filter(a => a.error).length;
      const scores = Object.values(audit.ranking?.scores || {}); const best = scores.length ? Math.max(...scores) : null;
      const rounds = new Set(audit.attempts.map(a => a.round)).size;
      const flash = cands * 3 + rounds * 2 + 4;
      const cost = src === 'vsai' ? VSAI_PHOTO_COST + flash * FLASH_CALL : cands * NANO_GEN_COST + flash * FLASH_CALL;
      const approved = audit.delivered && fs.existsSync(audit.delivered) ? audit.delivered : null;
      const dst = approved ? path.join(BK, `${stem(r.input)}.${src}.approved.jpg`) : null; if (approved) fs.copyFileSync(approved, dst);
      // move this run's artifacts aside so the other source doesn't overwrite them
      for (const f of fs.readdirSync(OUT)) if (f.startsWith(`${stem(r.input)}.${tagFor(r)}`)) fs.renameSync(path.join(OUT, f), path.join(BK, `${src}.${f}`));
      row.sources[src] = { delivered: !!approved, candidates: cands, compliant, errors, rounds, bestDesignScore: best, seconds: +sec.toFixed(0), estCost: +cost.toFixed(2), file: dst };
      console.log(`${r.input} [${src}] ${approved ? 'DELIVERED' : 'rejected'} — ${compliant}/${cands} compliant, best score ${best}, ${sec.toFixed(0)}s, ~$${cost.toFixed(2)}`);
    }
    await sideBySide([r.input, row.sources.nano?.file, row.sources.vsai?.file], path.join(BK, `${stem(r.input)}.sidebyside.jpg`));
    card.push(row);
  }
  fs.writeFileSync(path.join(BK, 'scorecard.json'), JSON.stringify(card, null, 2));
  const agg = s => { const rows = card.map(c => c.sources[s]).filter(Boolean); const n = rows.length || 1; return { delivered: rows.filter(x => x.delivered).length, rows: rows.length, compliance: rows.reduce((a, x) => a + x.compliant / Math.max(1, x.candidates), 0) / n, score: rows.filter(x => x.bestDesignScore != null).reduce((a, x) => a + x.bestDesignScore, 0) / Math.max(1, rows.filter(x => x.bestDesignScore != null).length), sec: rows.reduce((a, x) => a + x.seconds, 0) / n, cost: rows.reduce((a, x) => a + x.estCost, 0) / n }; };
  const md = ['# Bake-off scorecard', '', '| source | delivered | avg compliance | avg best design score | avg seconds | avg est. cost |', '|---|---|---|---|---|---|'];
  for (const s of Object.keys(SOURCES)) { const a = agg(s); md.push(`| ${s} | ${a.delivered}/${a.rows} | ${(100 * a.compliance).toFixed(0)}% | ${a.score.toFixed(1)} | ${a.sec.toFixed(0)} | $${a.cost.toFixed(2)} |`); }
  md.push('', 'Cost model: VSAI = plan price / 150 photos per job (regenerations are unlimited, so retries are free); nano = per-generation list price; flash calls ≈ $0.008 each. Grade the blind sheet to decide — these numbers are the judge\'s opinion, not yours.');
  fs.writeFileSync(path.join(BK, 'scorecard.md'), md.join('\n')); console.log('\n' + md.join('\n'));
  // blind grading sheet
  const key = {}; const sections = [];
  for (const c of card) {
    const a = c.sources.nano?.file, b = c.sources.vsai?.file; if (!a && !b) continue;
    const flip = crypto.createHash('md5').update(c.room).digest()[0] % 2 === 0; key[c.room] = flip ? { A: 'vsai', B: 'nano' } : { A: 'nano', B: 'vsai' };
    const A = flip ? b : a, B = flip ? a : b;
    const img = f => f && fs.existsSync(f) ? `<img src="data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}">` : '<div class="none">no compliant result</div>';
    sections.push(`<div class="case" data-id="${c.room}"><div class="hdr"><b>${c.room}</b> · ${c.roomType} · ${c.style}</div><div class="imgs"><figure>${img(A)}<figcaption>A</figcaption></figure><figure>${img(B)}<figcaption>B</figcaption></figure></div><div class="grade"><label><input type="radio" name="${c.room}" value="A"> A is better</label> <label><input type="radio" name="${c.room}" value="B"> B is better</label> <label><input type="radio" name="${c.room}" value="tie"> tie</label> <label><input type="radio" name="${c.room}" value="neither"> neither is deliverable</label></div></div>`);
  }
  fs.writeFileSync(path.join(BK, 'blind-key.json'), JSON.stringify(key, null, 2));
  fs.writeFileSync(path.join(BK, 'GRADE-ME.html'), `<!doctype html><meta charset="utf-8"><title>Bake-off — blind grading</title><style>body{font:14px -apple-system,Helvetica;background:#0f1115;color:#e8eaf0;margin:24px}.case{border:1px solid #2a2f3a;border-radius:10px;padding:14px;margin-bottom:18px}.hdr{color:#9fb3ff;margin-bottom:8px}.imgs{display:flex;gap:10px}figure{margin:0;flex:1}img{width:100%;border-radius:6px}figcaption{font-size:12px;color:#8a90a0}.none{aspect-ratio:3/2;background:#1a1f28;display:flex;align-items:center;justify-content:center;color:#8a90a0}.grade label{margin-right:14px}#bar{position:sticky;top:0;background:#0f1115;padding:10px 0;border-bottom:1px solid #2a2f3a;margin-bottom:16px}button{background:#3b82f6;color:#fff;border:0;padding:8px 14px;border-radius:8px;font-weight:600}textarea{width:100%;height:80px;background:#161a22;color:#e8eaf0;border:1px solid #2a2f3a;margin-top:8px}</style><div id="bar"><b>Blind bake-off</b> — sources are hidden and shuffled per room. Pick the one you'd deliver. <button onclick="exp()">Export</button><textarea id="out"></textarea></div>${sections.join('')}<script>function exp(){const o={};document.querySelectorAll('.case').forEach(c=>{const r=c.querySelector('input:checked');o[c.dataset.id]=r?r.value:'skip'});document.getElementById('out').value=JSON.stringify(o)}</script>`);
  console.log(`\nBlind grading sheet → ${path.join(BK, 'GRADE-ME.html')}`);
})();
