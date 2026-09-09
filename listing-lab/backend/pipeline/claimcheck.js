/**
 * Listing Lab — the claim check.
 *
 * WHY (the owner's grades, 4 Sep 2026). A kids' bedroom declutter was refused
 * three times, and the last refusal said "the dark rug in the corner was
 * removed" and "the lettering on the wall plaques was mangled". The rug is in
 * both frames. The names read the same. The judge invented two violations,
 * $1.89 and a sellable photograph were thrown away, and with two votes that
 * must both pass, one hallucinating vote is enough to do it every time.
 *
 * So a judge that claims a specific object was REMOVED, REPLACED, MOVED or
 * ALTERED must say where (a box), and the claim is checked against evidence:
 *
 *   1. Arithmetic first. If that patch of the frame is essentially unchanged
 *      between original and candidate, the object is still there as it was —
 *      the claim is false, no model needed.
 *   2. Otherwise the judge is shown the two crops side by side and asked one
 *      question: is the claim true in these crops? The same judge, proper
 *      evidence — the pattern the region review and the appliance roll call
 *      use — asked only about the thing it asserted.
 *
 * Scope is deliberately narrow: only object-level removal/replacement claims
 * are checked. Leftovers, ghosts, camera, architecture and lighting claims
 * are never touched here. A disproved claim is dropped from the verdict and
 * recorded as `disproved` so the audit shows what happened.
 */
const sharp = require('sharp');
const { geminiGenerateContent } = require('./gemini');

const CLAIM_RE = /\b(removed|missing|gone|erased|deleted|replaced|swapped|moved|relocated|altered|garbled|mangled|corrupt|changed into|turned into)\b/i;
// Claims this check must never touch — those are the checks that keep the
// product honest, and a leftover is proven by the checklist, not disproved here.
const NEVER_RE = /\b(left|remain|still|leftover|clutter|residue|ghost|smear|smudge|artifact|camera|viewpoint|framing|angle|perspective|exposure|brightness|lighting|white balance|flooring|floor (material|finish|planks?|tiles?|colou?r)|paint|wall colou?r|added|invent)\b/i;

const SAMPLE_W = 640;
const UNCHANGED_MEAN = 7;      // mean |Δ| per channel, 0–255, over the box
const UNCHANGED_SHARE = 0.12;  // share of box pixels with |Δ| > 24

async function raw(buf) {
  const { data, info } = await sharp(buf).resize({ width: SAMPLE_W }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

function boxDiff(o, c, box) {
  const [y0, x0, y1, x1] = box.map(v => Math.max(0, Math.min(1000, v)) / 1000);
  const W = o.w, H = o.h;
  const px0 = Math.floor(x0 * W), px1 = Math.max(px0 + 2, Math.ceil(x1 * W));
  const py0 = Math.floor(y0 * H), py1 = Math.max(py0 + 2, Math.ceil(y1 * H));
  let sum = 0, n = 0, big = 0;
  for (let y = py0; y < Math.min(py1, H); y++) for (let x = px0; x < Math.min(px1, W); x++) {
    const i = (y * W + x) * 3;
    const d = (Math.abs(o.data[i] - c.data[i]) + Math.abs(o.data[i + 1] - c.data[i + 1]) + Math.abs(o.data[i + 2] - c.data[i + 2])) / 3;
    sum += d; n++; if (d > 24) big++;
  }
  return n ? { mean: sum / n, share: big / n, pixels: n } : null;
}

async function cropB64(buf, box, pad = 0.35) {
  const meta = await sharp(buf).metadata();
  const [y0, x0, y1, x1] = box;
  const W = meta.width, H = meta.height;
  const bw = (x1 - x0) / 1000, bh = (y1 - y0) / 1000;
  const px0 = Math.max(0, Math.round((x0 / 1000 - pad * bw) * W)), py0 = Math.max(0, Math.round((y0 / 1000 - pad * bh) * H));
  const px1 = Math.min(W, Math.round((x1 / 1000 + pad * bw) * W)), py1 = Math.min(H, Math.round((y1 / 1000 + pad * bh) * H));
  const w = Math.max(48, px1 - px0), h = Math.max(48, py1 - py0);
  const out = await sharp(buf).extract({ left: px0, top: py0, width: Math.min(w, W - px0), height: Math.min(h, H - py0) })
    .resize({ width: 512 }).jpeg({ quality: 90 }).toBuffer();
  return out.toString('base64');
}

function checkable(v) {
  if (!v || v.severity !== 'major') return false;
  const b = v.box_2d;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(n => Number.isFinite(n))) return false;
  const t = String(v.text || '');
  return CLAIM_RE.test(t) && !NEVER_RE.test(t);
}

/**
 * Check every checkable major claim in `verdict.violationDetails`. Mutates the
 * verdict: disproved claims move to `verdict.disproved`, `violations` and
 * `pass` are recomputed. Returns the list of disproved claims.
 */
async function checkClaims(apiKey, model, origBuf, candBuf, verdict) {
  const claims = (verdict.violationDetails || []).filter(checkable);
  if (!claims.length) return [];
  const [o, c] = await Promise.all([raw(origBuf), raw(candBuf)]);
  if (o.w !== c.w || o.h !== c.h) return [];   // different frames: nothing to compare
  const disproved = [];
  for (const v of claims) {
    const d = boxDiff(o, c, v.box_2d);
    if (!d) continue;
    if (d.mean < UNCHANGED_MEAN && d.share < UNCHANGED_SHARE) {
      disproved.push({ ...v, how: 'pixels', diff: { mean: +d.mean.toFixed(1), share: +d.share.toFixed(3) } });
      continue;
    }
    // The patch did change; ask the judge about its own claim, with the crops.
    try {
      const parts = [{
        text: `You made this claim about an AI-edited real-estate photo: "${v.text}"
Below are close-up crops of exactly that spot — BEFORE from the original, AFTER from the edited photo. Judge ONLY this claim from these crops. Clutter being removed from on or around an object does not make the object "removed" or "replaced"; the same object, same kind, same position, with less on it, means the claim is FALSE. Answer with ONLY JSON: {"claim_true": true|false, "evidence": "one sentence"}` },
        { text: 'BEFORE:' }, { inline_data: { mime_type: 'image/jpeg', data: await cropB64(origBuf, v.box_2d) } },
        { text: 'AFTER:' }, { inline_data: { mime_type: 'image/jpeg', data: await cropB64(candBuf, v.box_2d) } },
      ];
      const json = await geminiGenerateContent(apiKey, model, { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, response_mime_type: 'application/json' } });
      const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
      const out = JSON.parse(text);
      if (out && out.claim_true === false) disproved.push({ ...v, how: 'crops', evidence: String(out.evidence || '').slice(0, 160) });
    } catch { /* an unavailable check leaves the claim standing */ }
  }
  if (disproved.length) {
    const gone = new Set(disproved.map(x => x.text));
    verdict.disproved = disproved.map(x => ({ text: x.text, how: x.how, evidence: x.evidence, diff: x.diff }));
    verdict.violationDetails = verdict.violationDetails.filter(x => !gone.has(x.text));
    verdict.violations = verdict.violationDetails.filter(x => x.severity === 'major').map(x => x.text);
    verdict.pass = verdict.violations.length === 0;
  }
  return disproved;
}

module.exports = { checkClaims, boxDiff, checkable };
