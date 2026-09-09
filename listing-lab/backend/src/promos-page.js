/**
 * The owner's promo-code screen, served at /internal/board/promos?s=SECRET.
 *
 * Built 28 Aug 2026 because Kyle's real question wasn't "mint me five codes" —
 * it was "how do I know who used what without coming back to you every time?"
 * The answer: the ledger already names every redeemer, and this page lets him
 * mint and watch on his own. Styled to match the app's studio theme.
 */
export const PROMOS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Promo Codes — Listing Lab</title>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3">
<style>
:root{
  --bg:#0C1118; --surface:#131A24; --surface2:#19222E; --line:#293546;
  --ink:#E9EDF3; --soft:#A0ABBA; --faint:#6B7787;
  --pine:#4E8FD0; --pine-deep:#14304F; --ok:#46B98A; --warn:#D9A441;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:0 18px 80px}
.wrap{max-width:680px;margin:0 auto}
h1{font-size:22px;margin:28px 0 4px}
.sub{color:var(--soft);font-size:14px;margin:0 0 22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px;margin-top:16px}
label{display:block;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:12px 0 5px}
input,select{width:100%;padding:11px 12px;border-radius:8px;background:var(--surface2);border:1px solid var(--line);color:var(--ink);font:inherit;font-size:15px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
button.mint{width:100%;margin-top:16px;padding:13px;background:var(--pine);color:#08131F;border:0;border-radius:8px;font:700 15px Inter,sans-serif;cursor:pointer}
button.mint:disabled{opacity:.5}
.code-row{border-top:1px solid var(--line);padding:13px 0}
.code-row:first-child{border-top:0}
.code-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.code{font:700 22px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.05em}
.pill{font-size:13px;font-weight:700;letter-spacing:.05em;border-radius:99px;padding:5px 12px}
.pill.unused{background:var(--pine-deep);color:#8FBEE8}
.pill.used{background:rgba(70,185,138,.12);color:var(--ok)}
.pill.dead{background:rgba(217,164,65,.12);color:var(--warn)}
.meta{color:var(--faint);font-size:12.5px;margin-left:auto}
.who{color:var(--soft);font-size:13px;margin-top:5px}
.who b{color:var(--ink);font-weight:600}
.copy{background:none;border:1px solid var(--line);color:var(--soft);border-radius:6px;font-size:11.5px;padding:3px 9px;cursor:pointer}
.copy:active{border-color:var(--pine);color:var(--pine)}
.note{color:var(--faint);font-size:12.5px;margin-top:3px}
#msg{margin-top:12px;font-size:14px;color:var(--ok);min-height:20px}
#msg.err{color:#E2615A}
a{color:var(--pine)}
</style>
</head>
<body>
<div class="wrap">
  <h1>Promo codes</h1>
  <p class="sub">Mint a code, hand it out, and watch who redeems it — every redemption names its account below. <a id="backLink" href="#">Back to dashboard</a></p>

  <div class="card">
    <label>Code (leave blank to auto-generate)</label>
    <input id="code" placeholder="AMBER10, FIRST5-A, BETA-MONDAY…" autocapitalize="characters" autocomplete="off">
    <div class="row">
      <div><label>Credits</label><input id="credits" type="number" inputmode="numeric" value="10" min="1" max="500"></div>
      <div><label>Total uses (1 = single-use)</label><input id="uses" type="number" inputmode="numeric" value="1" min="1" max="10000"></div>
    </div>
    <label>Expires</label>
    <select id="expiry">
      <option value="">Never</option>
      <option value="7">In 7 days</option>
      <option value="14">In 14 days</option>
      <option value="30">In 30 days</option>
    </select>
    <label>Note to self (optional)</label>
    <input id="note" placeholder="Facebook first-five, Monday beta…">
    <button class="mint" id="mint">Mint code</button>
    <div id="msg"></div>
  </div>

  <div class="card">
    <div id="list" class="faint">Loading…</div>
  </div>
</div>
<script>
const S = '__SECRET__';
document.getElementById('backLink').href = '/internal/board?s=' + S;
const $ = id => document.getElementById(id);

async function load(){
  const r = await fetch('/internal/board/promo?s=' + S);
  const { codes } = await r.json();
  if (!codes.length) { $('list').innerHTML = '<span style="color:var(--faint)">No codes yet — mint the first one above.</span>'; return; }
  $('list').innerHTML = codes.map(c => {
    const dead = (c.expiresAt && c.expiresAt <= new Date().toISOString());
    const state = dead ? '<span class="pill dead">EXPIRED</span>'
      : c.uses >= c.maxUses ? '<span class="pill used">FULLY USED</span>'
      : c.uses > 0 ? '<span class="pill used">' + c.uses + ' / ' + c.maxUses + ' USED</span>'
      : '<span class="pill unused">UNUSED</span>';
    const who = (c.redeemedBy || []).map(p =>
      '<div class="who">→ <b>' + esc(p.name || p.email) + '</b>' + (p.name ? ' · ' + esc(p.email) : '') +
      ' · ' + new Date(p.at).toLocaleDateString('en-US', { month:'short', day:'numeric' }) + '</div>').join('');
    return '<div class="code-row"><div class="code-line">' +
      '<span class="code">' + esc(c.code) + '</span>' + state +
      '<button class="copy" data-code="' + esc(c.code) + '">Copy</button>' +
      '<span class="meta">' + c.credits + ' credits' + (c.expiresAt && !dead ? ' · expires ' + new Date(c.expiresAt).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '') + '</span>' +
      '</div>' + (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') + who + '</div>';
  }).join('');
}
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

document.addEventListener('click', async e => {
  const cp = e.target.closest('.copy');
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.code); cp.textContent = 'Copied!'; setTimeout(()=>cp.textContent='Copy', 1400); } catch{} return; }
  if (e.target.id !== 'mint') return;
  const btn = $('mint'); btn.disabled = true;
  $('msg').className = ''; $('msg').textContent = '';
  try {
    const days = $('expiry').value;
    const body = {
      credits: parseInt($('credits').value, 10),
      maxUses: parseInt($('uses').value, 10),
      note: $('note').value.trim() || null,
      expiresAt: days ? new Date(Date.now() + days*86400000).toISOString() : null,
    };
    if ($('code').value.trim()) body.code = $('code').value.trim();
    const r = await fetch('/internal/board/promo?s=' + S, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const out = await r.json();
    if (!r.ok) throw new Error(out?.error?.message || 'Could not mint that code.');
    $('msg').textContent = 'Minted ' + out.code + ' — ' + out.credits + ' credits.';
    $('code').value = ''; $('note').value = '';
    load();
  } catch (err) {
    $('msg').className = 'err'; $('msg').textContent = err.message;
  } finally { btn.disabled = false; }
});
load();
</script>
</body>
</html>`;
