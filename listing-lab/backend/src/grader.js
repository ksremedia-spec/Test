/**
 * Listing Lab — the grading page.
 *
 * WHY IT IS A SEPARATE PAGE AND NOT PART OF THE APP
 * This is Kyle's instrument, not a customer feature. It reaches across every
 * account because it measures the SYSTEM, and it is never linked from the
 * product — the same rule the business dashboard follows.
 *
 * WHY IT IS DELIBERATELY PLAIN
 * The bottleneck in grading sixty photographs is not the photographs, it is
 * photograph twenty-three. Anything that costs a second per job costs a minute
 * over the set, and the set stops getting finished. So: one job on screen, a
 * slider, three big targets, keyboard shortcuts, and progress saved the instant
 * a button is pressed. No lists, no navigation, no "are you sure".
 *
 * WHY THE SYSTEM'S VERDICT IS HIDDEN UNTIL HE ANSWERS
 * The entire value of this exercise is in the disagreement between his verdict
 * and ours. Showing him "we rejected this" before he looks anchors the answer,
 * and an anchored grade measures nothing except how persuasive our own label is.
 * It appears after he has committed, because seeing it then is useful — that is
 * the moment a disagreement is interesting.
 */
export const GRADER_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Listing Lab — grading</title>
<style>
  :root{
    --ink:#f2ede6; --soft:#a9a29a; --faint:#6f6963;
    --bg:#111211; --card:#191a19; --line:#2b2c2b;
    --pass:#4a8f5e; --fail:#a4483f; --wrong:#8a6d2f;
  }
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
  .wrap{max-width:760px;margin:0 auto;padding:14px}
  .top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
  .top h1{font-size:16px;font-weight:600;letter-spacing:.01em}
  .count{color:var(--soft);font-size:13.5px;font-variant-numeric:tabular-nums}
  .track{height:3px;background:var(--line);border-radius:2px;overflow:hidden;margin-bottom:12px}
  .track div{height:100%;background:var(--pass);width:0;transition:width .25s}
  .what{color:var(--soft);font-size:13.5px;margin-bottom:8px}
  .what b{color:var(--ink);font-weight:600}

  /* The comparison. Drag anywhere on it. */
  .ba{position:relative;width:100%;aspect-ratio:3/2;background:var(--card);border:1px solid var(--line);
      border-radius:10px;overflow:hidden;user-select:none;touch-action:none;cursor:ew-resize}
  .ba img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
  .ba .before{clip-path:inset(0 50% 0 0)}
  .ba .handle{position:absolute;top:0;bottom:0;left:50%;width:2px;background:rgba(255,255,255,.85);pointer-events:none}
  .ba .handle::after{content:"";position:absolute;top:50%;left:50%;width:34px;height:34px;transform:translate(-50%,-50%);
      border-radius:50%;background:rgba(255,255,255,.9);box-shadow:0 1px 6px rgba(0,0,0,.5)}
  .tag{position:absolute;top:8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
       background:rgba(0,0,0,.55);padding:3px 7px;border-radius:4px;color:#fff;pointer-events:none}
  .tag.l{left:8px} .tag.r{right:8px}

  .btns{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}
  button{font:inherit;font-weight:600;color:var(--ink);border:1px solid var(--line);background:var(--card);
         border-radius:10px;padding:16px 10px;cursor:pointer}
  button:active{transform:translateY(1px)}
  .pass{background:var(--pass);border-color:var(--pass)}
  .fail{background:var(--fail);border-color:var(--fail)}
  .wrong{grid-column:1/-1;background:transparent;color:var(--wrong);border-color:var(--wrong);padding:12px}
  .row2{display:grid;grid-template-columns:auto 1fr;gap:9px;margin-top:9px;align-items:center}
  .ghost{background:transparent;color:var(--soft);padding:10px 14px;font-weight:500}
  input[type=text]{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);
       border-radius:10px;padding:11px 12px;width:100%}
  input::placeholder{color:var(--faint)}
  .said{margin-top:11px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;
        background:var(--card);font-size:13.5px;color:var(--soft)}
  .said b{color:var(--ink)}
  .agree{color:var(--pass)} .disagree{color:var(--wrong)}
  .hint{color:var(--faint);font-size:12px;margin-top:10px;text-align:center}
  .done{text-align:center;padding:40px 10px}
  .done h2{font-size:19px;margin-bottom:8px}
  .done p{color:var(--soft);margin-bottom:6px}
  .tally{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:16px;text-align:left}
  .tally div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .tally .n{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
  .tally .k{font-size:12px;color:var(--soft)}
  @media(max-width:420px){ button{padding:18px 8px} }
</style>
<div class="wrap">
  <div id="app"><p style="color:var(--soft)">Loading…</p></div>
</div>
<script>
const $ = id => document.getElementById(id);
const S = new URLSearchParams(location.search).get('s') || '';
// ?since=YYYY-MM-DD narrows the queue to jobs created on/after that date —
// added 2 Sep 2026 when the all-time queue opened Kyle on 8-day-old jobs
// from a system three rebuilds ago and he understandably hit the roof.
const SINCE = new URLSearchParams(location.search).get('since') || '';
const api = (p, init) => fetch(p + (p.includes('?') ? '&' : '?') + 's=' + encodeURIComponent(S), init).then(r => r.json());

const LABEL = { declutter:'Declutter', empty:'Empty room', staging:'Virtual staging', twilight:'Twilight' };
let jobs = [], i = 0;

(async function start(){
  const out = await api('/internal/grade/jobs' + (SINCE ? '?since=' + encodeURIComponent(SINCE) : ''));
  // Ungraded first, in order. Re-grading is possible but should never be the
  // thing standing between him and the next unanswered job.
  jobs = (out.jobs || []).filter(j => j.afterUrl);
  jobs.sort((a,b) => (a.myVerdict?1:0) - (b.myVerdict?1:0));
  i = jobs.findIndex(j => !j.myVerdict);
  if (i < 0) i = jobs.length;
  render();
})();

function render(){
  const graded = jobs.filter(j => j.myVerdict).length;
  if (i >= jobs.length) return renderDone(graded);
  const j = jobs[i];
  const what = [LABEL[j.transformation] || j.transformation, j.roomType, j.style].filter(Boolean).join(' · ');

  $('app').innerHTML = \`
    <div class="top"><h1>Grading</h1><div class="count">\${graded} of \${jobs.length}</div></div>
    <div class="track"><div style="width:\${jobs.length ? graded/jobs.length*100 : 0}%"></div></div>
    <div class="what"><b>\${what}</b></div>
    <div class="ba" id="ba">
      <img class="after" src="\${j.afterUrl}" alt="result">
      <img class="before" id="beforeImg" src="\${j.beforeUrl || ''}" alt="original">
      <div class="handle" id="handle"></div>
      <span class="tag l">before</span><span class="tag r">after</span>
    </div>
    <div class="btns">
      <button class="fail" id="bFail">Fail</button>
      <button class="pass" id="bPass">Pass</button>
      <button class="wrong" id="bWrong">Wrong job for this photo</button>
    </div>
    <div class="row2">
      <button class="ghost" id="bBack">← Back</button>
      <input type="text" id="note" placeholder="Note (optional) — what's wrong with it?">
    </div>
    <div id="said"></div>
    <p class="hint">Drag to compare. Keys: <b>P</b> pass · <b>F</b> fail · <b>W</b> wrong job</p>\`;

  wireSlider();
  $('bPass').onclick  = () => grade('pass');
  $('bFail').onclick  = () => grade('fail');
  $('bWrong').onclick = () => grade('wrong_job');
  $('bBack').onclick  = () => { if (i > 0) { i--; render(); } };
}

function wireSlider(){
  const ba = $('ba'), before = $('beforeImg'), handle = $('handle');
  const set = clientX => {
    const r = ba.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, (clientX - r.left) / r.width * 100));
    before.style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
    handle.style.left = pct + '%';
  };
  let down = false;
  const start = e => { down = true; set((e.touches ? e.touches[0] : e).clientX); };
  const move  = e => { if (down) { e.preventDefault(); set((e.touches ? e.touches[0] : e).clientX); } };
  const end   = () => { down = false; };
  ba.addEventListener('pointerdown', start);
  window.addEventListener('pointermove', move, { passive:false });
  window.addEventListener('pointerup', end);
  ba.addEventListener('touchstart', start, { passive:true });
  window.addEventListener('touchmove', move, { passive:false });
  window.addEventListener('touchend', end);
}

/**
 * Save, then reveal what the system thought.
 *
 * The reveal is the reward for answering, and it is only shown afterwards — a
 * verdict formed after reading ours is not an independent verdict, and the
 * disagreement between the two is the only thing this exercise produces.
 */
async function grade(verdict){
  const j = jobs[i];
  const note = ($('note').value || '').trim();
  j.myVerdict = verdict; j.myNote = note;
  api('/internal/grade/' + encodeURIComponent(j.jobId), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verdict, note }),
  }).catch(() => {});

  const weDelivered = j.systemVerdict === 'delivered';
  const heLiked = verdict === 'pass';
  const agree = weDelivered === heLiked;
  const line = weDelivered
    ? 'We <b>delivered</b> this.'
    : 'We <b>rejected</b> it' + (j.systemNote ? ' — ' + escapeHtml(j.systemNote.slice(0, 130)) : '') + '.';
  const verdictLine = verdict === 'wrong_job'
    ? '<span class="disagree">Noted as the wrong job for this photo.</span>'
    : agree ? '<span class="agree">Agreed.</span>'
      : heLiked ? '<span class="disagree">You would have shipped it — our checks are costing you this one.</span>'
                : '<span class="disagree">We shipped something you would not send. That is the one that matters.</span>';
  $('said').innerHTML = '<div class="said">' + line + ' ' + verdictLine + '</div>';

  setTimeout(() => { i++; render(); }, agree && verdict !== 'wrong_job' ? 450 : 1600);
}

function renderDone(graded){
  const tally = { pass:0, fail:0, wrong_job:0, shipped_bad:0, refused_good:0 };
  for (const j of jobs) {
    if (!j.myVerdict) continue;
    tally[j.myVerdict]++;
    if (j.systemVerdict === 'delivered' && j.myVerdict === 'fail') tally.shipped_bad++;
    if (j.systemVerdict === 'rejected' && j.myVerdict === 'pass') tally.refused_good++;
  }
  const rate = graded ? Math.round(tally.pass / graded * 100) : 0;
  $('app').innerHTML = \`
    <div class="done">
      <h2>All \${graded} graded</h2>
      <p>Your pass rate: <b>\${rate}%</b></p>
      <div class="tally">
        <div><div class="n">\${tally.pass}</div><div class="k">you passed</div></div>
        <div><div class="n">\${tally.fail}</div><div class="k">you failed</div></div>
        <div><div class="n">\${tally.refused_good}</div><div class="k">we refused, you'd have shipped</div></div>
        <div><div class="n">\${tally.shipped_bad}</div><div class="k">we shipped, you wouldn't</div></div>
        <div><div class="n">\${tally.wrong_job}</div><div class="k">wrong job chosen</div></div>
      </div>
      <p style="margin-top:16px;font-size:13px;color:var(--faint)">The bottom two boxes are the ones worth fixing.</p>
    </div>\`;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Keys, because sixty photographs on a laptop should be sixty keystrokes.
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'p') grade('pass');
  else if (k === 'f') grade('fail');
  else if (k === 'w') grade('wrong_job');
});
</script>`;
