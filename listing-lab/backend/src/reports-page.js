/**
 * The owner's problem-report queue, at /internal/board/reports?s=SECRET.
 *
 * Each row is one customer complaint pinned to one job: who, what they said,
 * what the job was, what it actually cost. The owner decides the answer —
 * usually a re-run or a minted courtesy code — and marks it resolved. The
 * abuse control is the policy, not the software: everything is on the record.
 */
export const REPORTS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Reports — Listing Lab</title>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3">
<style>
:root{
  --bg:#0C1118; --surface:#131A24; --surface2:#19222E; --line:#293546;
  --ink:#E9EDF3; --soft:#A0ABBA; --faint:#6B7787;
  --pine:#4E8FD0; --ok:#46B98A; --warn:#D9A441;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:0 18px 80px}
.wrap{max-width:680px;margin:0 auto}
h1{font-size:22px;margin:28px 0 4px}
.sub{color:var(--soft);font-size:14px;margin:0 0 22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:4px 18px;margin-top:16px}
.rep{border-top:1px solid var(--line);padding:15px 0}
.rep:first-child{border-top:0}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.who{font-weight:600}
.pill{font-size:11px;font-weight:700;letter-spacing:.05em;border-radius:99px;padding:3px 9px}
.pill.open{background:rgba(217,164,65,.12);color:var(--warn)}
.pill.resolved{background:rgba(70,185,138,.12);color:var(--ok)}
.meta{color:var(--faint);font-size:12.5px;margin-left:auto}
.msg{margin:8px 0 6px;color:var(--ink);font-size:15px}
.jobline{color:var(--soft);font-size:13px}
.jobline b{color:var(--ink)}
button.res{margin-top:9px;background:none;border:1px solid var(--line);color:var(--soft);border-radius:7px;font-size:12.5px;padding:6px 12px;cursor:pointer}
button.res:hover{border-color:var(--pine);color:var(--pine)}
.empty{color:var(--faint);padding:18px 0}
a{color:var(--pine)}
</style>
</head>
<body>
<div class="wrap">
  <h1>Problem reports</h1>
  <p class="sub">One row per complaint, pinned to its job. Your usual answers: re-run it, or mint a courtesy code on the <a id="promoLink" href="#">promo screen</a> — then mark it resolved. <a id="backLink" href="#">Back to dashboard</a></p>
  <div class="card"><div id="list" class="empty">Loading…</div></div>
</div>
<script>
const S = '__SECRET__';
document.getElementById('backLink').href = '/internal/board?s=' + S;
document.getElementById('promoLink').href = '/internal/board/promos?s=' + S;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const T = { declutter:'Declutter', empty:'Empty Room', staging:'Virtual Staging', twilight:'Twilight' };

async function load(){
  const r = await fetch('/internal/board/reports.json?s=' + S);
  const { reports } = await r.json();
  if (!reports.length) { $('list').innerHTML = '<div class="empty">No reports. Quiet is good.</div>'; return; }
  $('list').innerHTML = reports.map(p => \`
    <div class="rep">
      <div class="top">
        <span class="who">\${esc(p.customer.name || p.customer.email)}</span>
        <span class="pill \${p.status}">\${p.status.toUpperCase()}</span>
        <span class="meta">\${new Date(p.at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
      </div>
      <div class="msg">\${esc(p.message)}</div>
      <div class="jobline"><b>\${T[p.job.transformation] || esc(p.job.transformation)}</b>
        · job \${esc(p.job.status)}\${p.job.costUsd != null ? ' · cost $' + p.job.costUsd.toFixed(2) : ''}
        · \${esc(p.customer.email)}
        \${p.job.status === 'delivered' ? ' · <a href="/internal/board/deliveries?s=' + S + '#' + esc(p.job.id) + '">view delivery →</a>' : ''}</div>
      \${p.status === 'open' ? '<button class="res" data-id="' + esc(p.id) + '">Mark resolved</button>' : ''}
    </div>\`).join('');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('.res');
  if (!b) return;
  b.disabled = true;
  await fetch('/internal/board/reports/resolve?s=' + S, {
    method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id: b.dataset.id }),
  });
  load();
});
load();
</script>
</body>
</html>`;
