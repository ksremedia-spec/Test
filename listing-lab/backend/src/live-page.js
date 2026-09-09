/**
 * The owner's LIVE view — what is running right now, in plain English.
 *
 * Built during the beta (31 Aug 2026) because Kyle was finding out about stuck
 * jobs from customer texts. This page is the other way round: every job from
 * the last 24 hours, refreshed every 8 seconds, with the raw log errors
 * translated into sentences a person can act on.
 *
 * Same gate as the rest of the board: DIAG_SECRET in the URL, 404 without it,
 * never linked from anything a customer sees.
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/**
 * Raw error → a sentence. The order matters: the first match wins, and the
 * specific (breaker, kill, rate limit) sit above the generic (500, timeout).
 */
export function explainError(raw) {
  const s = String(raw || '');
  if (!s) return null;
  if (/circuit breaker|upstream outage/i.test(s)) {
    return "Google was refusing everything, so the attempt stopped early instead of grinding — the job parked and will retry.";
  }
  if (/exceeded \d+ms and was killed/i.test(s)) {
    return 'The run used its full time limit without finishing and was stopped. Almost always means Google was refusing calls the whole time.';
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|rate limit|quota/i.test(s)) {
    return 'Google told us to slow down (a rate limit). The job retries automatically; generation falls back to the flash model.';
  }
  if (/high demand|overloaded|\b503\b|UNAVAILABLE/i.test(s)) {
    return "Google's image service was overloaded — their capacity, everyone affected, not something we did. The job waits and retries.";
  }
  if (/\b500\b/.test(s)) {
    return "Google returned an internal error. Usually a blip that clears on the automatic retry.";
  }
  if (/pipeline exited null|SIGKILL|SIGTERM|socket hang up|ECONNRESET/i.test(s)) {
    return 'The run was interrupted mid-render — typically our own deploy restarting the machine. It restarts by itself.';
  }
  if (/timed out|ran out of time|not enough time left/i.test(s)) {
    return 'A call to Google took too long and the run gave the job back to the queue for a fresh start.';
  }
  if (/User location|FAILED_PRECONDITION/i.test(s)) {
    return 'Google refused this datacenter by location; the system switches to another route automatically.';
  }
  return s.slice(0, 200);
}

/** One job row → the plain-status sentence for the Status column. */
export function plainStatus(j, now = Date.now()) {
  const min = v => Math.max(0, Math.round((now - Date.parse(v)) / 60000));
  const took = j.finished_at
    ? ((Date.parse(j.finished_at) - Date.parse(j.created_at)) / 60000).toFixed(1)
    : null;
  switch (j.status) {
    case 'delivered': return `Delivered in ${took} min`;
    case 'rejected':  return `Returned after ${took} min — nothing passed the checks, credits back`;
    case 'failed':    return `Ended after ${took} min — credits back`;
    case 'queued':
      return j.retry_after
        ? `Parked (${j.outage_retries || 0} ${(j.outage_retries || 0) === 1 ? 'wait' : 'waits'} so far) — retries shortly`
        : `Waiting to start — ${min(j.created_at)} min old`;
    case 'running':   return `Working — ${min(j.created_at)} min in` +
      ((j.outage_retries || 0) > 0 ? ` (survived ${j.outage_retries} Google ${j.outage_retries === 1 ? 'wait' : 'waits'})` : '');
    default:          return j.status;
  }
}

const T_LABEL = { declutter: 'Declutter', staging: 'Virtual Staging', twilight: 'Twilight', empty: 'Empty Room' };

/** The JSON the page polls. */
export async function liveJobsJson(env) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { results: jobs } = await env.DB.prepare(
    `SELECT j.id, j.transformation, j.style, j.room_type, j.status, j.outage_retries,
            j.retry_after, j.created_at, j.last_dispatch_at, j.finished_at, j.rejection_note,
            a.email
       FROM jobs j LEFT JOIN accounts a ON a.id = j.account_id
      WHERE j.created_at > ? ORDER BY j.created_at DESC LIMIT 60`
  ).bind(since).all();
  const { results: att } = await env.DB.prepare(
    `SELECT job_id, outcome, audit_json, created_at FROM job_attempts
      WHERE created_at > ? ORDER BY created_at DESC LIMIT 300`
  ).bind(since).all();
  // Latest raw error per job — the attempts arrive newest-first.
  const lastError = {};
  for (const r of att || []) {
    if (lastError[r.job_id] !== undefined) continue;
    try {
      const a = JSON.parse(r.audit_json || '{}');
      lastError[r.job_id] = a.error || null;
    } catch { lastError[r.job_id] = null; }
  }
  const now = Date.now();
  return (jobs || []).map(j => ({
    id: j.id,
    who: j.email || '—',
    what: T_LABEL[j.transformation] || j.transformation,
    opts: [j.style, j.room_type].filter(Boolean).join(' · ') || null,
    status: j.status,
    live: !j.finished_at,
    plain: plainStatus(j, now),
    startedAt: j.created_at,
    waits: j.outage_retries || 0,
    lastError: explainError(lastError[j.id]) || (j.status === 'rejected' || j.status === 'failed' ? explainError(j.rejection_note) : null),
  }));
}

/**
 * One job's full story, for the tap-to-open detail on the live page: the
 * images (original, the refused frame if one was kept, the delivered result)
 * and every attempt — real ones with the judges' objections verbatim, outage
 * waits as one translated line each.
 */
export async function liveJobJson(env, id) {
  const job = await env.DB.prepare(
    `SELECT j.*, a.email, p.original_key
       FROM jobs j
       LEFT JOIN accounts a ON a.id = j.account_id
       LEFT JOIN photos p ON p.id = j.photo_id
      WHERE j.id = ?`
  ).bind(id).first();
  if (!job) return null;
  const { results: att } = await env.DB.prepare(
    `SELECT attempt_no, outcome, audit_json, created_at FROM job_attempts
      WHERE job_id = ? ORDER BY created_at`
  ).bind(id).all();

  const events = [];
  for (const r of att || []) {
    let aud = {};
    try { aud = JSON.parse(r.audit_json || '{}'); } catch {}
    if (r.attempt_no >= 1000) {
      // An outage wait, not a real attempt — one translated line.
      events.push({ kind: 'wait', at: r.created_at, text: explainError(aud.error) || 'Parked to wait out a service problem.' });
      continue;
    }
    // A real attempt: surface each candidate's verdict and the objections
    // exactly as the judges wrote them — that IS the failure Kyle wants to see.
    const cands = Array.isArray(aud.attempts) ? aud.attempts : [];
    events.push({
      kind: 'attempt', at: r.created_at, no: r.attempt_no, outcome: r.outcome,
      error: aud.error ? explainError(aud.error) : null,
      candidates: cands.map(c => ({
        pass: c.pass ?? c.verdict?.pass ?? null,
        violations: (c.violations || c.verdict?.violations || []).slice(0, 4),
        realism: c.realism || null,
        // A candidate can pass the judges and still die at a later gate —
        // structure, realism, design score, watermark. Name the killer.
        killedBy: c.killedBy || null,
        structViolations: (c.structure?.violations || []).slice(0, 3),
      })),
    });
  }
  return {
    id: job.id,
    status: job.status,
    note: job.rejection_note || null,
    originalKey: job.original_key || null,
    // Deliberately named for what it is: evidence, never a result.
    rejectKey: job.reject_key || null,
    resultKey: job.result_key || null,
    events,
  };
}

/** The page itself. */
export function livePage(secret) {
  const s = encodeURIComponent(secret);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Live — Listing Lab</title><style>
  body{margin:0;background:#0C1118;color:#E9EDF3;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:22px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:#A0ABBA;font-size:13.5px;margin:0 0 16px}.sub a{color:#6EA5E1}
  .card{border:1px solid #293546;border-radius:14px;background:#10161F;padding:14px 16px;margin-bottom:10px}
  .card.live{border-color:#2E5A8F;box-shadow:0 0 0 1px rgba(110,165,225,.15)}
  .top{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
  .what{font-weight:700}
  .who{color:#A0ABBA;font-size:13px}
  .plain{margin-top:4px;font-size:14.5px}
  .plain.go{color:#8FD0A8}.plain.no{color:#E8A2A2}.plain.ok{color:#8FBEE8}
  .err{margin-top:6px;font-size:13.5px;color:#D9C08A;background:rgba(217,192,138,.07);border:1px solid rgba(217,192,138,.25);border-radius:8px;padding:8px 10px}
  .stamp{color:#5E6B7E;font-size:12.5px}
  .empty{color:#A0ABBA;padding:30px 0;text-align:center}
  .dot{display:inline-block;width:8px;height:8px;border-radius:99px;background:#4ECB92;margin-right:7px;animation:p 1.4s infinite}
  @keyframes p{50%{opacity:.35}}
  .card.open{border-color:#3D5A85}
  .card[data-id]{cursor:pointer}
  .detail{margin-top:12px;border-top:1px solid #293546;padding-top:12px}
  .dimgs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}
  .dimgs figure{margin:0;max-width:240px}
  .dimgs img{width:100%;border-radius:10px;border:1px solid #293546;display:block}
  .dimgs figcaption{font-size:12px;color:#A0ABBA;margin-top:4px}
  .dimgs figure.refused img{border-color:#7A4444}
  .ev{margin:8px 0;font-size:13.5px}
  .ev .t{color:#5E6B7E;font-size:12px;margin-right:8px}
  .ev.wait{color:#D9C08A}
  .vio{margin:4px 0 0 14px;color:#E8A2A2}
  .vio li{margin:2px 0}
  .cand{margin:5px 0 0 6px;padding-left:10px;border-left:2px solid #293546}
  .cand.pass{border-left-color:#2E7A55;color:#8FD0A8}
</style></head><body>
<h1>Live</h1>
<p class="sub">Every job from the last 24 hours, plain English, refreshes itself every 8 seconds.
<a href="/internal/board?s=${s}">← Dashboard</a></p>
<div id="rows"><p class="empty">Loading…</p></div>
<script>
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CLS = { delivered:'ok', rejected:'no', failed:'no', running:'go', queued:'go' };
const IMG = k => '/internal/board/img?s=${s}&key=' + encodeURIComponent(k);
const open = new Set();          // which jobs Kyle has expanded — survives refresh
const detailCache = {};

function detailHtml(d){
  const figs = [];
  if (d.originalKey) figs.push('<figure><img loading="lazy" src="' + IMG(d.originalKey) + '"><figcaption>Original</figcaption></figure>');
  if (d.rejectKey) figs.push('<figure class="refused"><img loading="lazy" src="' + IMG(d.rejectKey) + '"><figcaption>What we refused to deliver</figcaption></figure>');
  if (d.resultKey) figs.push('<figure><img loading="lazy" src="' + IMG(d.resultKey) + '"><figcaption>Delivered</figcaption></figure>');
  const time = at => new Date(at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  const evs = (d.events || []).map(ev => {
    if (ev.kind === 'wait') return '<div class="ev wait"><span class="t">' + time(ev.at) + '</span>' + esc(ev.text) + '</div>';
    const KILLER = { structure: 'the fixed-features check', realism: 'the realism check',
                     'design-score': "the head stager's design score", watermark: 'watermark verification' };
    const cands = (ev.candidates || []).map(c => {
      const vios = list => list && list.length
        ? '<ul class="vio">' + list.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul>' : '';
      if (c.pass && c.killedBy) {
        return '<div class="cand">Passed the judges — then refused by ' + esc(KILLER[c.killedBy] || c.killedBy) +
          vios(c.structViolations) + '</div>';
      }
      if (c.pass) return '<div class="cand pass">Candidate passed the checks</div>';
      return '<div class="cand">Candidate refused' + vios(c.violations) + '</div>';
    }).join('');
    return '<div class="ev"><span class="t">' + time(ev.at) + '</span>Attempt ' + ev.no + ' — ' + esc(ev.outcome) +
      (ev.error ? '<div class="err">' + esc(ev.error) + '</div>' : '') + cands + '</div>';
  }).join('');
  return '<div class="detail"><div class="dimgs">' + figs.join('') + '</div>' +
    (evs || '<div class="ev">No attempt records for this job.</div>') +
    (d.note ? '<div class="stamp" style="margin-top:8px">Customer saw: “' + esc(d.note) + '”</div>' : '') + '</div>';
}

async function toggle(card){
  const id = card.dataset.id;
  if (open.has(id)) { open.delete(id); card.classList.remove('open'); const el = card.querySelector('.detail'); if (el) el.remove(); return; }
  open.add(id); card.classList.add('open');
  if (!detailCache[id]) {
    try {
      const res = await fetch('/internal/board/live/job.json?s=${s}&id=' + encodeURIComponent(id));
      if (res.ok) detailCache[id] = await res.json();
    } catch {}
  }
  if (open.has(id) && detailCache[id] && !card.querySelector('.detail')) {
    card.insertAdjacentHTML('beforeend', detailHtml(detailCache[id]));
  }
}

async function refresh(){
  try {
    const res = await fetch('/internal/board/live.json?s=${s}');
    if (!res.ok) return;
    const jobs = await res.json();
    const box = document.getElementById('rows');
    if (!jobs.length) { box.innerHTML = '<p class="empty">Nothing in the last 24 hours.</p>'; return; }
    box.innerHTML = jobs.map(j => \`
      <div class="card \${j.live ? 'live' : ''} \${open.has(j.id) ? 'open' : ''}" data-id="\${esc(j.id)}">
        <div class="top">
          <span class="what">\${j.live ? '<span class="dot"></span>' : ''}\${esc(j.what)}\${j.opts ? ' <span class="who">· ' + esc(j.opts) + '</span>' : ''}</span>
          <span class="who">\${esc(j.who)}</span>
        </div>
        <div class="plain \${CLS[j.status] || ''}">\${esc(j.plain)}</div>
        \${j.lastError ? '<div class="err">' + esc(j.lastError) + '</div>' : ''}
        <div class="stamp">started \${new Date(j.startedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})} · tap for the full story</div>
      </div>\`).join('');
    // Re-open what was open, from cache, so the 8s refresh never closes a
    // detail Kyle is reading. A live job's story updates on next expand.
    for (const card of box.querySelectorAll('.card[data-id]')) {
      card.onclick = () => toggle(card);
      const id = card.dataset.id;
      if (open.has(id) && detailCache[id]) card.insertAdjacentHTML('beforeend', detailHtml(detailCache[id]));
    }
  } catch {}
}
refresh(); setInterval(refresh, 8000);
</script>
</body></html>`;
}
