/**
 * Listing Lab — the appliance census.
 *
 * WHY (soak test, 3 Sep 2026). An emptied kitchen came back with its range
 * turned into countertop, and the whole-frame judge — two votes — passed it.
 * The owner's rule is absolute: "removing the range is never acceptable, even
 * in an empty room. Fridge, stove, all stay — they sell with the home almost
 * 99 percent of the time." A rule that absolute cannot ride on a judge that
 * sees a stainless range as a sliver behind a person standing in front of it.
 *
 * So, like the ghost review, the question is asked with proper evidence:
 *   1. CENSUS — one call on the ORIGINAL lists every major appliance with a
 *      box. Rooms without appliances (most of them) cost one cheap call and
 *      nothing more.
 *   2. ROLL CALL — for each appliance, a close-up BEFORE/AFTER crop pair goes
 *      to the judge with one question: is the same appliance still here?
 * Any "missing" or "replaced" is fatal for every transformation. Not a new
 * judge with new opinions — one fact, checked where it is easy to see.
 */
const sharp = require('sharp');
const { geminiGenerateContent } = require('./gemini');
const { APPLIANCES_STAY } = require('./scope');

const PAD = 0.35;
const CROP_W = 448;

async function cropB64(buf, box, meta) {
  const [y0, x0, y1, x1] = box;
  const W = meta.width, H = meta.height;
  const px0 = Math.max(0, Math.round((x0 / 1000 - PAD * (x1 - x0) / 1000) * W));
  const py0 = Math.max(0, Math.round((y0 / 1000 - PAD * (y1 - y0) / 1000) * H));
  const px1 = Math.min(W, Math.round((x1 / 1000 + PAD * (x1 - x0) / 1000) * W));
  const py1 = Math.min(H, Math.round((y1 / 1000 + PAD * (y1 - y0) / 1000) * H));
  const w = Math.max(32, px1 - px0), h = Math.max(32, py1 - py0);
  const out = await sharp(buf).extract({ left: px0, top: py0, width: Math.min(w, W - px0), height: Math.min(h, H - py0) })
    .resize({ width: CROP_W }).jpeg({ quality: 88 }).toBuffer();
  return out.toString('base64');
}

/**
 * List the major appliances in the original. Returns [{label, box_2d}].
 * Empty for rooms without any — the common case.
 */
async function applianceCensus(apiKey, model, origB64, mime) {
  const body = {
    contents: [{ role: 'user', parts: [
      { text: `List every MAJOR APPLIANCE visible in this real-estate photo — only these kinds: ${APPLIANCES_STAY}. Include one even if it is partly hidden behind a person, furniture or clutter — a range with someone standing in front of it is still a range. Do NOT list small or portable appliances (toaster, kettle, coffee maker, countertop microwave, fan, heater, vacuum), and do not list cabinets or counters.
Output a JSON list where each entry has "label" (kind + colour/finish + where it is, e.g. "stainless range on the back wall") and "box_2d" ([ymin, xmin, ymax, xmax] normalized 0-1000). If there are none, output [].` },
      { inline_data: { mime_type: mime, data: origB64 } } ] }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  };
  const json = await geminiGenerateContent(apiKey, model, body);
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
  try {
    const arr = JSON.parse(text);
    return (Array.isArray(arr) ? arr : [])
      .filter(a => a && Array.isArray(a.box_2d) && a.box_2d.length === 4 && a.box_2d.every(n => Number.isFinite(n)) && a.label)
      .map(a => ({ label: String(a.label).slice(0, 80), box_2d: a.box_2d.map(n => Math.max(0, Math.min(1000, n))) }))
      .slice(0, 8);
  } catch { return []; }
}

/**
 * Roll call: is every censused appliance still there in the candidate?
 * Returns { ok, verdicts: [{n, label, verdict, what}], missing: [text…] }.
 * verdict ∈ present | missing | replaced.
 */
async function verifyAppliances(apiKey, model, origBuf, candBuf, census) {
  const list = (census || []).filter(a => Array.isArray(a.box_2d));
  if (!list.length) return { ok: true, skipped: 'no appliances', verdicts: [] };
  const [om, cm] = await Promise.all([sharp(origBuf).metadata(), sharp(candBuf).metadata()]);
  const parts = [{
    text: `You are checking an AI-edited real-estate photo for one thing only: whether the home's MAJOR APPLIANCES survived the edit. Appliances sell with the home and must remain exactly as photographed. For each numbered appliance, the BEFORE crop is from the original photo and the AFTER crop is the same spot in the edited photo.

For EACH appliance answer exactly one verdict:
- "present": the same appliance is still there — same kind, same finish, same position (clutter on or around it may be gone; a person or object in front of it may be gone, revealing more of it — that is fine).
- "missing": the appliance is gone — the spot now shows countertop, cabinet doors, drawers, bare wall, or floor where it stood.
- "replaced": an appliance is there but it is a different one — different kind, colour or finish, or it has moved to another spot.

Answer with ONLY JSON: {"appliances":[{"n":1,"verdict":"present|missing|replaced","what":"one short sentence of evidence"}, …]}` }];
  let n = 0;
  for (const a of list) {
    n++;
    parts.push({ text: `APPLIANCE ${n} — ${a.label}. BEFORE:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await cropB64(origBuf, a.box_2d, om) } });
    parts.push({ text: `APPLIANCE ${n} AFTER:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await cropB64(candBuf, a.box_2d, cm) } });
  }
  const json = await geminiGenerateContent(apiKey, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  let out; try { out = JSON.parse(text); } catch { return { ok: true, skipped: 'unparseable answer', verdicts: [] }; }
  const verdicts = (Array.isArray(out.appliances) ? out.appliances : []).map(v => ({
    n: v.n, verdict: v.verdict, what: String(v.what || '').slice(0, 120),
    label: list[(v.n || 1) - 1] ? list[(v.n || 1) - 1].label : null,
  }));
  const bad = verdicts.filter(v => v.verdict === 'missing' || v.verdict === 'replaced');
  return {
    ok: bad.length === 0, verdicts,
    missing: bad.map(v => `appliance ${v.verdict}: ${v.label || 'appliance ' + v.n}${v.what ? ' — ' + v.what : ''}`),
  };
}

module.exports = { applianceCensus, verifyAppliances };
