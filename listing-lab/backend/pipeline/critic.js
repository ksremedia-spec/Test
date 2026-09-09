/**
 * Listing Lab — realism critic. The compliance judge and design scorer view the
 * whole frame, where a smeared canvas or a melted frame is twenty pixels of
 * nothing. This critic finds WHERE the candidate differs most from the original
 * (i.e. where furniture/decor was added), crops those regions at native
 * resolution, and has a reviewer grade each crop for generation artifacts:
 * smeared/incoherent artwork, melted geometry, warped
 * straight lines, mangled patterns or text. Returns per-crop verdicts and an
 * overall pass (no crop rated 'severe').
 */
const sharp = require('sharp');
const { geminiGenerateContent } = require('./gemini');

/** Find the N tiles (4x4 grid) where candidate differs most from original. */
async function hotspots(origBuf, candBuf, n = 4) {
  const W = 512;
  const [o, c] = await Promise.all([origBuf, candBuf].map(b => sharp(b).resize(W, W, { fit: 'fill' }).greyscale().raw().toBuffer()));
  const G = 4, tile = W / G, scores = [];
  for (let ty = 0; ty < G; ty++) for (let tx = 0; tx < G; tx++) {
    let s = 0;
    for (let y = 0; y < tile; y += 2) for (let x = 0; x < tile; x += 2) { const i = (ty * tile + y) * W + tx * tile + x; s += Math.abs(o[i] - c[i]); }
    scores.push({ tx, ty, s });
  }
  return scores.sort((a, b) => b.s - a.s).slice(0, n);
}

/** Locate high-risk regions: wall art AND reflective surfaces (mirrors, glass tops, metallic/mirrored furniture) — each gets its own crop. */
async function findArt(apiKey, model, candBuf) {
  const small = await sharp(candBuf).resize({ width: 1024 }).jpeg({ quality: 80 }).toBuffer();
  const json = await geminiGenerateContent(apiKey, model, { contents: [{ role: 'user', parts: [
    { text: 'List every HIGH-RISK region in this staged room photo: (a) each piece of framed wall art or canvas; (b) each mirror, glass-topped table, mirrored or high-gloss metallic furniture piece; (c) each area rug. Respond ONLY JSON: {"art":[{"x_from":%,"x_to":%,"y_from":%,"y_to":%,"kind":"art|reflective|rug"}]} using percent of image width/height (y from top). Empty array if none.' },
    { inline_data: { mime_type: 'image/jpeg', data: small.toString('base64') } }] }], generationConfig: { temperature: 0, response_mime_type: 'application/json' } });
  try { return (JSON.parse(json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}').art || []).slice(0, 4); } catch { return []; }
}

async function buildCrops(apiKey, model, origBuf, candBuf, opts = {}) {
  const meta = await sharp(candBuf).metadata();
  const spots = await hotspots(origBuf, candBuf, opts.crops || 4);
  const art = (await findArt(apiKey, model, candBuf).catch(() => [])).slice(0, 6);
  const G = 4; const crops = [];
  const add = async (left, top, w, h, label) => {
    left = Math.max(0, Math.min(meta.width - 8, Math.floor(left))); top = Math.max(0, Math.min(meta.height - 8, Math.floor(top)));
    // Floors of 8 (1 Sep 2026): a zero-or-negative span from a judge's box
    // (x_to <= x_from) reached sharp as a bad extract area and killed the run.
    w = Math.max(8, Math.floor(Math.min(w, meta.width - left))); h = Math.max(8, Math.floor(Math.min(h, meta.height - top)));
    const buf = await sharp(candBuf).extract({ left, top, width: w, height: h }).jpeg({ quality: 92 }).toBuffer();
    crops.push({ label, left, top, w, h, b64: buf.toString('base64'), px: Math.round(100 * left / meta.width), py: Math.round(100 * top / meta.height) });
  };
  for (const { tx, ty } of spots) await add(tx * meta.width / G, ty * meta.height / G, meta.width / G, meta.height / G, 'changed region');
  for (const a of art) { const padX = meta.width * 0.02, padY = meta.height * 0.02; await add(meta.width * a.x_from / 100 - padX, meta.height * a.y_from / 100 - padY, meta.width * (a.x_to - a.x_from) / 100 + 2 * padX, meta.height * (a.y_to - a.y_from) / 100 + 2 * padY, a.kind === 'reflective' ? 'reflective' : a.kind === 'rug' ? 'rug' : 'wall art'); }
  return crops;
}

async function critiqueRealism(apiKey, model, origBuf, candBuf, opts = {}) {
  const prebuilt = opts.prebuilt || await buildCrops(apiKey, model, origBuf, candBuf, opts);
  const parts = [{ text: `You are the retoucher doing final QC on a virtually staged real-estate photo before delivery. Each image below is a FULL-RESOLUTION crop of a region where content was added. Work through this checklist for every crop — these are the documented tells of bad AI staging:
1. GROUND CONTACT & LEGS: count legs on every chair/stool/table/bed — wrong count, bent, tapering-to-nothing, or vanishing-into-carpet legs are SEVERE. Every leg/base must touch the floor with a small dark contact shadow at the junction; a floating piece or a sliver of floor under a leg is SEVERE; a generic blurry gray blob instead of a contact shadow is minor-to-severe.
2. GEOMETRY: rigid objects (frames, lamps, vases, shelf lines, table edges) must hold straight edges and symmetric silhouettes — melted, wobbling, or dissolving forms are SEVERE; furniture blending into a wall or another object with a muddy boundary is SEVERE.
3. ARTWORK (crops labelled "wall art", strictest read): a canvas whose content is smeared, half-empty, dissolving, or ghosted is SEVERE — no real print looks like that. Deliberate soft abstracts are fine.
4. REFLECTIVE SURFACES (crops labelled "reflective"): judge the OBJECT only — a mirror or glass table whose frame wobbles, whose panels melt, or whose edges dissolve is SEVERE. Do NOT judge what the reflection shows. A mirror reflecting the empty room, reflecting something not in the scene, or reflecting nothing at all is NOT a defect — ignore reflection content entirely. Glossy floors: ignore whether sheen reflections match.
5. RUGS: a rug that floats above the floor, clips under a wall, has torn/dissolving edges, or fails to pass under furniture legs correctly is SEVERE. A rug that reads as a flat printed sticker with hard fake edges is SEVERE; a rug that is merely soft, low-detail, or blurry at this resolution is MINOR — real rugs photograph soft.
6. SURFACES UNDER/AROUND FURNITURE: floor plank direction, grain, carpet texture, baseboards, outlets, vents must continue unbroken behind and beneath added pieces — eaten trim or regenerated flooring is SEVERE.
7. COMPOSITING: masking halos or smudged bands around furniture silhouettes, resolution/grain mismatch between piece and room, plastic/CGI fabric or wood texture — minor-to-severe by visibility.
8. CONTENT: gibberish text on books/art/labels is SEVERE; near-identical cloned decor items, lamps with no cords near no outlets, thriving plants in impossible spots, fused objects, floating shadows — minor-to-severe.
Ignore composition, taste, and soft focus from resizing. Severity per crop: "none" (clean), "minor" (visible at 100% zoom, most buyers won't notice), "severe" (a defect a paying client would reject).
Respond ONLY JSON: {"crops":[{"index":1,"severity":"none|minor|severe","issue":"..."}], "worst":"none|minor|severe"}` }];
  const boxes = [];
  prebuilt.forEach((c, i) => {
    boxes.push({ left: c.left, top: c.top, w: c.w, h: c.h });
    parts.push({ text: `Crop ${i + 1} (${c.label}, region x ${c.px}%, y ${c.py}%):` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: c.b64 } });
  });
  const json = await geminiGenerateContent(apiKey, model, { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, response_mime_type: 'application/json' } });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try {
    const v = JSON.parse(text);
    const rank = { none: 0, minor: 1, severe: 2 };
    const worst = (v.crops || []).reduce((a, c) => rank[c.severity] > rank[a] ? c.severity : a, 'none');
    return { crops: (v.crops || []).map((c, i) => ({ ...c, box: boxes[c.index - 1] || boxes[i] })), worst, pass: worst !== 'severe' };
  } catch { return { crops: [], worst: 'unknown', pass: true, note: text.slice(0, 150) }; }
}

/**
 * Voted realism critique: 3 independent reviewer calls over the SAME crops
 * (crops computed once). Per crop, severity = majority vote (ties round up).
 * Overall pass = no crop with majority-severe. Same pattern as the judge:
 * variance smoothed without leniency.
 */
async function critiqueRealismVoted(apiKey, model, origBuf, candBuf, opts = {}) {
  const votes = Math.max(1, opts.votes || 3);
  const prebuilt = await buildCrops(apiKey, model, origBuf, candBuf, opts);
  const runs = (await Promise.allSettled(Array.from({ length: votes }, () => critiqueRealism(apiKey, model, origBuf, candBuf, { ...opts, prebuilt }))))
    .filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!runs.length) return { worst: 'unknown', pass: true, error: 'all critic calls failed' };
  const n = runs.length, rank = { none: 0, minor: 1, severe: 2 };
  // vote per crop index (crop sets are recomputed per run but near-identical; index-align defensively)
  const maxCrops = Math.max(...runs.map(r => (r.crops || []).length));
  const crops = [];
  for (let i = 0; i < maxCrops; i++) {
    const sev = runs.map(r => r.crops?.[i]?.severity).filter(Boolean);
    const severeVotes = sev.filter(x => x === 'severe').length, minorVotes = sev.filter(x => x === 'minor').length;
    const severity = severeVotes * 2 >= sev.length && severeVotes > 0 ? 'severe' : (minorVotes + severeVotes) * 2 > sev.length ? 'minor' : 'none';
    const issue = runs.map(r => r.crops?.[i]).filter(c => c && c.severity !== 'none').map(c => c.issue).filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
    crops.push({ index: i + 1, severity, issue, votes: sev });
  }
  const worst = crops.reduce((a, c) => rank[c.severity] > rank[a] ? c.severity : a, 'none');
  return { crops, worst, pass: worst !== 'severe', votes: n };
}

module.exports = { critiqueRealism, critiqueRealismVoted };
