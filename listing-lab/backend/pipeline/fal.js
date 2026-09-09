/**
 * THE THIRD DOOR (31 Aug 2026).
 *
 * fal.ai serves the SAME gemini-3-pro-image ("Nano Banana Pro") from its own
 * capacity arrangements — a third counter to the identical kitchen. Kyle's
 * week produced six Google "high demand" windows, and his own system had
 * already proven doors fail separately (26 Aug: the developer API refused for
 * an hour while Vertex answered the same minute). Same model, same pixels,
 * zero re-validation — just one more independent line to stand in when
 * Google's two public counters are mobbed.
 *
 * Wearing nanoBananaEdit's contract: (key, prompt, imageB64, mime, opts) →
 * { data, mime_type }, so generateImage can knock here without translation.
 * Reference images (masked-rescue worked examples) ride along via fal's
 * multi-image input, in the same order the Gemini door sends them.
 *
 * Dormant unless FAL_KEY is set.
 */

const meter = require('./meter.js');
const { msLeft } = require('./gemini.js');

const FAL_URL = process.env.FAL_EDIT_URL || 'https://fal.run/fal-ai/nano-banana-pro/edit';
/**
 * STORM MODE (31 Aug 2026, Kyle: "worst case scenario backups"): FLUX.2 [pro]
 * edit — a different vendor's model entirely, the consensus runner-up for
 * in-place editing that leaves untouched regions untouched. Reached only when
 * every route to BOTH Google models is jammed. Safe by construction: its
 * frames face the same judges, colour lock, structural checks and watermark
 * as everything else — the worst it can do is get rejected.
 */
const FLUX_URL = process.env.FAL_FLUX_URL || 'https://fal.run/fal-ai/flux-2-pro/edit';
const FLUX_MODEL_NAME = 'flux-2-pro';


/**
 * THE QUEUE FALLBACK (2 Sep 2026, Kyle: "make those changes to fal").
 * fal's direct endpoints (fal.run) answer "slow down" — 429/502/503 — when
 * saturated instead of waiting. Under a Google jam an entire batch funnels to
 * fal at once, and that seam was the last way traffic could kill a job. Now a
 * saturated direct call falls to fal's QUEUE API (queue.fal.run): submit the
 * identical payload, poll the status URL it returns, fetch the result when
 * COMPLETED. No latency cost on a clear day (direct is still first), and
 * under saturation the job waits in line instead of dying.
 */
/**
 * A LOCKED ANSWER IS RETRIED (4 Sep 2026). After a top-up, fal answered
 * "User is locked. Reason: TOP_UP" from SOME of its edge nodes and served the
 * same key fine from others — the same call, seconds apart, 403 then 200 —
 * for many minutes while the top-up propagated. Nine of ten jobs died on it.
 * Every fal request here gets three more tries, a few seconds apart, when
 * the answer is that lock; anything else is returned as it came.
 */
const LOCKED_RE = /user is locked/i;
async function fetchUnlessLocked(url, init, ac, tries = 4) {
  let res, text;
  for (let i = 0; i < tries; i++) {
    res = await fetch(url, init);
    text = await res.text();
    if (!(res.status === 403 && LOCKED_RE.test(text))) break;
    if (i < tries - 1) await new Promise(r => setTimeout(r, 3000));
    if (ac.signal.aborted) break;
  }
  return { res, text };
}

async function falPostWithQueue(falKey, directUrl, payload, ac, label) {
  const headers = { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' };
  const { res, text } = await fetchUnlessLocked(directUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal }, ac);
  if (res.ok) return { text, status: res.status, queued: false };
  // 403 "User is locked. Reason: TOP_UP" (4 Sep 2026): after a top-up, fal's
  // direct endpoint kept answering locked while its queue endpoint served the
  // same key fine. Nine of ten jobs died on it. A locked direct door is a
  // reason to try the queue, exactly like a saturated one.
  const LOCKED = res.status === 403 && /locked/i.test(text);
  if (![429, 502, 503].includes(res.status) && !LOCKED) return { text, status: res.status, queued: false };
  // Saturated — take a ticket instead.
  const queueUrl = directUrl.replace('https://fal.run/', 'https://queue.fal.run/');
  const { res: sub, text: subText } = await fetchUnlessLocked(queueUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal }, ac);
  if (!sub.ok) return { text: `${label} queue submit ${sub.status}: ${subText.slice(0, 150)} (direct was ${res.status})`, status: sub.status, queued: true };
  const ticket = JSON.parse(subText);
  const statusUrl = ticket.status_url, responseUrl = ticket.response_url;
  if (!statusUrl || !responseUrl) return { text: `${label} queue returned no ticket: ${subText.slice(0, 150)}`, status: 500, queued: true };
  for (;;) {
    await new Promise(r => setTimeout(r, 3000));
    if (ac.signal.aborted) throw Object.assign(new Error(`${label} queue wait hit the time budget`), { name: 'AbortError' });
    const st = await fetch(statusUrl, { headers: { 'Authorization': `Key ${falKey}` }, signal: ac.signal });
    const stBody = await st.json().catch(() => ({}));
    if (stBody.status === 'COMPLETED') break;
    if (st.status >= 400 || stBody.status === 'FAILED') {
      return { text: `${label} queued request failed: ${JSON.stringify(stBody).slice(0, 150)}`, status: 500, queued: true };
    }
  }
  const { res: fin, text: finText } = await fetchUnlessLocked(responseUrl, { headers: { 'Authorization': `Key ${falKey}` }, signal: ac.signal }, ac);
  return { text: finText, status: fin.ok ? 200 : fin.status, queued: true };
}

/** '2K'/'4K'/'1K' pipeline sizes map straight onto fal's resolution knob. */
const sizeFor = s => (['1K', '2K', '4K'].includes(s) ? s : '2K');

async function falEdit(falKey, prompt, imageB64, imageMime, opts = {}) {
  const toUri = (mime, data) => `data:${mime || 'image/jpeg'};base64,${data}`;
  // Same ordering contract as the Gemini door: worked examples first, the
  // photo to edit LAST, with the prompt naming that convention.
  const refs = (opts.references || []);
  const image_urls = [
    ...refs.map(r => toUri(r.mime_type, r.data)),
    toUri(imageMime, imageB64),
  ];
  const fullPrompt = refs.length
    ? `${refs.map((r, i) => `Image ${i + 1}: ${r.label}`).join('\n')}\nThe LAST image is the photo to edit — output that one, transformed.\n\n${prompt}`
    : prompt;

  const budget = Math.min(180_000, msLeft());
  if (budget < 30_000) {
    const e = new Error('not enough time left for the third door — run interrupted, not failed');
    e.outOfTime = true;
    throw e;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);
  const t0 = Date.now();
  try {
    const res = await falPostWithQueue(falKey, FAL_URL, {
      prompt: fullPrompt,
      image_urls,
      resolution: sizeFor(opts.imageSize),
      output_format: 'jpeg',
      num_images: 1,
    }, ac, 'fal');
    const text = res.text;
    meter.note({ kind: 'image', model: 'gemini-3-pro-image', door: 'fal',
                 ms: Date.now() - t0, ok: res.status === 200, status: res.status, attempt: 1, queued: res.queued });
    if (res.status !== 200) throw new Error(`fal ${res.status}: ${text.slice(0, 200)}`);
    const out = JSON.parse(text);
    const url = out.images?.[0]?.url;
    if (!url) throw new Error(`fal returned no image: ${text.slice(0, 200)}`);
    const imgRes = await fetch(url, { signal: ac.signal });
    if (!imgRes.ok) throw new Error(`fal image download failed: ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { data: buf.toString('base64'), mime_type: out.images[0].content_type || 'image/jpeg' };
  } catch (e) {
    throw e.name === 'AbortError' ? new Error(`fal request timed out after ${(budget / 1000).toFixed(0)}s`) : e;
  } finally {
    clearTimeout(timer);
  }
}

/** The storm rung: same contract as falEdit, different model behind it. */
async function falFluxEdit(falKey, prompt, imageB64, imageMime, opts = {}) {
  const toUri = (mime, data) => `data:${mime || 'image/jpeg'};base64,${data}`;
  const refs = (opts.references || []);
  const image_urls = [
    ...refs.map(r => toUri(r.mime_type, r.data)),
    toUri(imageMime, imageB64),
  ];
  const fullPrompt = refs.length
    ? `${refs.map((r, i) => `Image ${i + 1}: ${r.label}`).join('\n')}\nThe LAST image is the photo to edit — output that one, transformed.\n\n${prompt}`
    : prompt;

  const budget = Math.min(180_000, msLeft());
  if (budget < 30_000) {
    const e = new Error('not enough time left for storm mode — run interrupted, not failed');
    e.outOfTime = true;
    throw e;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);
  const t0 = Date.now();
  try {
    // image_size auto: the output keeps the input's own shape; the pipeline's
    // resize-to-source on the way out normalises the rest.
    const res = await falPostWithQueue(falKey, FLUX_URL,
      { prompt: fullPrompt, image_urls, image_size: 'auto', output_format: 'jpeg' }, ac, 'fal-flux');
    const text = res.text;
    meter.note({ kind: 'image', model: FLUX_MODEL_NAME, door: 'fal',
                 ms: Date.now() - t0, ok: res.status === 200, status: res.status, attempt: 1, queued: res.queued });
    if (res.status !== 200) throw new Error(`fal-flux ${res.status}: ${text.slice(0, 200)}`);
    const out = JSON.parse(text);
    const url = out.images?.[0]?.url;
    if (!url) throw new Error(`fal-flux returned no image: ${text.slice(0, 200)}`);
    const imgRes = await fetch(url, { signal: ac.signal });
    if (!imgRes.ok) throw new Error(`fal-flux image download failed: ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { data: buf.toString('base64'), mime_type: out.images[0].content_type || 'image/jpeg' };
  } catch (e) {
    throw e.name === 'AbortError' ? new Error(`fal-flux request timed out after ${(budget / 1000).toFixed(0)}s`) : e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE FAL JUDGE DOOR (1 Sep 2026, Kyle: "Can't we do it through fal?").
 *
 * The verification suite — judges, classifiers, scope checks — ran only on
 * Google's vision models; on 1 Sep a finished fal-served generation burned
 * twelve minutes failing to reach a judge and died on the give-up ceiling.
 * fal's any-llm/vision service serves OTHER vendors' vision models (Claude
 * among them) under the SAME fal key already in production, so the judges get
 * their backup counter with no new account. Measured before wiring: a full
 * 2K delivery judged in 2.1s, multi-image requests honoured, JSON returned.
 *
 * Wears geminiGenerateContent's envelope: a Gemini-shaped request goes in,
 * a Gemini-shaped response comes out, no caller knows the difference. Never
 * used for generation — a judge door cannot draw, only judge.
 */
const ANY_LLM_URL = process.env.FAL_JUDGE_URL || 'https://fal.run/fal-ai/any-llm/vision';
// Claude through fal: independent of Google's weather, fast enough to sit
// mid-pipeline. Overridable without a deploy.
const FAL_JUDGE_MODEL = process.env.FAL_JUDGE_MODEL || 'anthropic/claude-haiku-4.5';

async function falVisionJudge(falKey, body, opts = {}) {
  const texts = [], images = [];
  for (const c of (body.contents || [])) {
    for (const p of (c.parts || [])) {
      if (p.text !== undefined) texts.push(p.text);
      else if (p.inline_data?.data) images.push(`data:${p.inline_data.mime_type || 'image/jpeg'};base64,${p.inline_data.data}`);
      else if (p.inlineData?.data) images.push(`data:${p.inlineData.mimeType || 'image/jpeg'};base64,${p.inlineData.data}`);
    }
  }
  const prompt =
    'You are a precise vision inspector for a real-estate photo system. Respond with ONLY the JSON or text the request asks for — no markdown fences, no commentary.\n\n'
    + (images.length > 1 ? `This request attaches ${images.length} images, in order.\n\n` : '')
    + texts.join('\n\n');

  const budget = Math.min(opts.timeoutMs || 60_000, msLeft());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budget);
  const t0 = Date.now();
  try {
    // Through the same direct-then-queue door as generation (4 Sep 2026: the
    // judge fallback died on the locked direct endpoint while the queue worked).
    const res = await falPostWithQueue(falKey, ANY_LLM_URL, {
      model: FAL_JUDGE_MODEL,
      prompt,
      ...(images.length === 1 ? { image_url: images[0] } : images.length ? { image_urls: images } : {}),
      temperature: body.generationConfig?.temperature ?? 0,
    }, ac, 'fal-judge');
    const text = res.text;
    res.ok = res.status >= 200 && res.status < 300;
    meter.note({ kind: 'fal-judge', model: FAL_JUDGE_MODEL, door: 'fal',
                 ms: Date.now() - t0, ok: res.ok, status: res.status, attempt: 1, queued: res.queued });
    if (!res.ok) throw new Error(`fal-judge ${res.status}: ${text.slice(0, 200)}`);
    const out = JSON.parse(text);
    if (out.error) throw new Error(`fal-judge error: ${String(out.error).slice(0, 200)}`);
    let reply = String(out.output ?? '');
    // The upstream parsers expect Gemini's unfenced JSON.
    reply = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '');
    return { candidates: [{ content: { parts: [{ text: reply }] } }], __judgedBy: 'fal-llm' };
  } catch (e) {
    throw e.name === 'AbortError' ? new Error(`fal-judge timed out after ${(budget / 1000).toFixed(0)}s`) : e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { falEdit, falFluxEdit, falVisionJudge, FLUX_MODEL_NAME, FAL_JUDGE_MODEL };
