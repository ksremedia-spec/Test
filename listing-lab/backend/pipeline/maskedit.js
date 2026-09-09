/**
 * Listing Lab — masked declutter (furniture-preserving edit).
 *
 * WHY THIS EXISTS
 * The image model does not edit a photograph; it re-renders the whole frame,
 * and on declutter it kept erasing furniture it was told to keep — the glass
 * coffee table, the blue cabinet, the lamps. Prompt feedback did not fix it
 * (1/9 rescued at three candidates a round, 28 Aug 2026) because the failure is
 * systematic, not unlucky. So the trust is inverted: the model's output is
 * believed ONLY inside the regions where clutter actually is, and the delivered
 * frame is the photographer's own pixels everywhere else. Furniture outside the
 * clutter regions cannot be removed — it is never generated.
 *
 * THE PIECES
 *   1. detectAndTrace — Gemini lists the clutter (boxes+labels), then traces
 *      each item's POLYGON in its own focused call. Polygons, not binary
 *      masks: asked for base64-PNG masks this model generation returns
 *      placeholders and raw coordinate strings (measured 3/3 on 28 Aug 2026);
 *      a polygon is pure text, every vertex checkable.
 *   2. Region identity is SEGMENTED ONCE per job and reused. Re-segmenting
 *      between rounds gives each round slightly different regions, and fills
 *      made for round N stop lining up with round N+1.
 *   3. scoreFill — a fill is believed for a region only if (a) it CHANGED the
 *      region's interior (else it cleaned nothing) and (b) it agrees with the
 *      original in a ring AROUND the region (else it hallucinated there — the
 *      ring is furniture/wall it was told not to touch). The ring excludes
 *      every region's pixels so a neighbouring item's legitimate removal is
 *      not read as hallucination.
 *   4. assemble — per region, the best qualifying fill is blended in through
 *      the region's feathered mask; regions with no qualifying fill keep the
 *      ORIGINAL pixels. Clutter surviving is a retry; ghosting is a lie.
 *   5. cropFill — the retry path for regions every whole-frame render fills
 *      unfaithfully: a tight crop puts the furniture in the model's face, and
 *      the result is colour-locked to the original crop (a crop is a re-render
 *      and carries drift that otherwise lands on the ring as false alarm).
 *
 * All pixel work is rect-local (a region's bounding box plus margins), never
 * whole-frame per region, so a 4K job stays inside container memory.
 */
const sharp = require('sharp');
sharp.cache(false);

/** Mean |orig−fill| in the ring at or below this (0–255 levels) is faithful.
 *
 * 9 → 15 on 28 Aug 2026, measured on the densest golden frame (124): at 9 the
 * gate rejected fills at ring 10–17 — ordinary lighting/JPEG drift on cluttered
 * scenes — leaving 10 of 12 regions untouched; at 15 eight cleaned, and the
 * composite inspected by eye had no seams or misalignment. The gate is a
 * pre-filter, not the last word: interior garbage that sneaks through still
 * fails the full judge (it did, twice, on the same frame — floating artifacts
 * under a mirror — before a later round fixed it). Genuinely misaligned fills
 * measure ring 20+ and still fail here. */
const RING_TOLERANCE = parseFloat(process.env.RING_TOLERANCE || '24');
// 24, up from 15 (2 Sep 2026): at 15 the whole-frame render's genuinely clean
// fills (playpen removed, shelves cleared) were refused over boundary drift
// the colour lock and feathering already absorb, so the path fell back to
// crop fills that changed nothing. The one judge still guards every
// composite, so a bad fill costs a verdict, never a delivery.
/** Interior must move at least this much — a no-op fill scores a perfect ring. */
const CHANGE_FLOOR = parseFloat(process.env.CHANGE_FLOOR || '8');

/* ------------------------------------------------------------ segmentation */

async function askJson(geminiGenerateContent, apiKey, model, imgB64, mime, text) {
  const body = {
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: imgB64 } },
      { text },
    ] }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  };
  const json = await geminiGenerateContent(apiKey, model, body);
  const raw = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
  try { return JSON.parse(raw); } catch (e) {
    const m = raw.match(/\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : [];
  }
}

function detectPrompt(clutterLine, keeperLine) {
  return `Find every piece of PERSONAL CLUTTER in this real-estate photo. Clutter means exactly: ${clutterLine}.

Do NOT include — these are the property and MUST NOT be listed, however cluttered they look: ${keeperLine || 'furniture in use, electronics in use, rugs, lamps, wall art, mirrors, curtains, towels, decorative styling, anything fitted to the building'}.

A piece of furniture with clutter ON it is not itself clutter: list the items on it, never the furniture. "Cluttered cart" or "messy shelf" are wrong answers; "items on the cart" is the right one.

Output a JSON list where each entry contains the 2D bounding box in the key "box_2d" ([ymin, xmin, ymax, xmax] normalized 0-1000) and a short descriptive text label in the key "label". Do NOT include masks in this step. If there is no clutter, output [].`;
}

/**
 * Detect clutter, then trace each item's polygon in its own focused call.
 * Returns [{label, box_2d, polygons|null}] — a null polygon means the item
 * could not be traced and will simply stay in the photo (never box-filled: a
 * bounding box around clutter on a cabinet swallowed the cabinet).
 */
async function detectAndTrace(deps, apiKey, model, origB64, mime, clutterLine, keeperLine) {
  const { geminiGenerateContent } = deps;
  const detected = await askJson(geminiGenerateContent, apiKey, model, origB64, mime, detectPrompt(clutterLine, keeperLine));
  const items = (Array.isArray(detected) ? detected : [])
    .filter(i => i && Array.isArray(i.box_2d) && i.box_2d.length === 4 && i.label);
  const traced = await Promise.all(items.map(async (it) => {
    const b = it.box_2d;
    const ask = `Trace the exact outline of the ${it.label} located inside the region [ymin=${b[0]}, xmin=${b[1]}, ymax=${b[2]}, xmax=${b[3]}] (all coordinates normalized 0-1000). Output ONLY JSON: a list where each entry has "label" and "polygon" — the polygon is a list of [y, x] vertex pairs (normalized 0-1000, 10 to 40 vertices) tracing tightly around the visible object. If the object has several separate parts, output one entry per part. Trace ONLY the ${it.label}; do not include any furniture surface it sits on.`;
    try {
      const res = await askJson(geminiGenerateContent, apiKey, model, origB64, mime, ask);
      const polygons = (Array.isArray(res) ? res : [])
        .map(r => r && r.polygon)
        .filter(p => Array.isArray(p) && p.length >= 3 &&
          p.every(v => Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= 0 && n <= 1000)));
      if (polygons.length) return { label: it.label, box_2d: b, polygons };
    } catch (e) { /* fall through */ }
    return { label: it.label, box_2d: b, polygons: null };
  }));
  return traced;
}

/* ------------------------------------------------------- rect-local pixels */

/** Pixel-space bounding rect of a region's polygons plus margin, clamped. */
function regionRect(polygons, W, H, marginPx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polygons) for (const [y, x] of poly) {
    const px = x / 1000 * W, py = y / 1000 * H;
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (py < y0) y0 = py; if (py > y1) y1 = py;
  }
  const left = Math.max(0, Math.floor(x0 - marginPx));
  const top = Math.max(0, Math.floor(y0 - marginPx));
  const right = Math.min(W, Math.ceil(x1 + marginPx));
  const bottom = Math.min(H, Math.ceil(y1 + marginPx));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Rasterize polygons into a rect-local single-channel raw mask (255=inside). */
async function rasterizePolys(polygons, W, H, rect, dilatePx) {
  const shapes = polygons.map(poly =>
    `<polygon points="${poly.map(([y, x]) => `${(x / 1000 * W - rect.left).toFixed(1)},${(y / 1000 * H - rect.top).toFixed(1)}`).join(' ')}" fill="white"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><rect width="100%" height="100%" fill="black"/>${shapes.join('')}</svg>`;
  let m = sharp(Buffer.from(svg)).greyscale();
  if (dilatePx > 0) m = sharp(await m.blur(Math.max(0.5, dilatePx / 2)).toBuffer()).threshold(16).greyscale();
  return m.raw().toBuffer();
}

/** Feather a rect-local binary mask for seamless blending. */
async function feather(maskRaw, rect, featherPx) {
  if (featherPx <= 0) return maskRaw;
  // extractChannel: sharp's blur silently promotes 1-channel raw to 3 channels,
  // which tripled the buffer and scrambled the blend's row/col math into
  // silent no-op writes (measured: composite delivered "cleaned" with the
  // clutter untouched). One channel in, one channel out, enforced.
  return sharp(maskRaw, { raw: { width: rect.width, height: rect.height, channels: 1 } })
    .blur(Math.max(0.5, featherPx / 2)).extractChannel(0).raw().toBuffer();
}

/** Extract a rect of an image buffer as rect-local RGB raw.
 * Defensive since 2 Sep 2026: a mis-sized buffer made sharp throw a FATAL
 * "extract_area: bad extract area" that killed whole jobs — now a rect that
 * does not fit the actual buffer resizes the buffer to the expected frame
 * first (never crashes the job over arithmetic). */
async function rectRaw(imgBuf, rect, frameW = null, frameH = null) {
  let img = sharp(imgBuf);
  if (frameW && frameH) {
    const m = await img.metadata();
    if (m.width !== frameW || m.height !== frameH) img = sharp(await img.resize(frameW, frameH, { fit: 'fill', kernel: 'lanczos3' }).toBuffer());
  }
  return img.extract(rect).removeAlpha().raw().toBuffer();
}

/* ---------------------------------------------------------------- scoring */

/**
 * A fill is {buf, left, top, width, height} — a whole frame has left/top 0 and
 * full dimensions. Returns null when the fill does not cover the region's rect
 * (a crop fill can only serve its own region).
 */
function fillCovers(fill, rect) {
  return fill.left <= rect.left && fill.top <= rect.top &&
    fill.left + fill.width >= rect.left + rect.width &&
    fill.top + fill.height >= rect.top + rect.height;
}

async function fillRectRaw(fill, rect) {
  // Same defence as rectRaw: a fill whose buffer disagrees with its claimed
  // dimensions is resized to them instead of crashing the extract.
  let img = sharp(fill.buf);
  const m = await img.metadata();
  if (m.width !== fill.width || m.height !== fill.height) img = sharp(await img.resize(fill.width, fill.height, { fit: 'fill', kernel: 'lanczos3' }).toBuffer());
  return img
    .extract({ left: rect.left - fill.left, top: rect.top - fill.top, width: rect.width, height: rect.height })
    .removeAlpha().raw().toBuffer();
}

/**
 * Score one fill for one region: ring agreement (outside the region and outside
 * EVERY region — allMaskRaw — so neighbours' legitimate removals don't count
 * against it) and interior change.
 */
/**
 * SCORING IS CACHED (soak test, 3 Sep 2026). The stuffed-closet declutter —
 * 17 regions, a dozen fills by round three — spent 80 seconds in each
 * assemble() decoding the same 12-megapixel frames over and over: every
 * (fill, region) pair was re-scored on every call, and the original was
 * re-decoded for every pair. Twice per round, three rounds, on the
 * container's slower CPU, and the process ran through its own deadline into
 * the 10-minute kill. A fill never changes once it exists and a region's
 * outline never changes, so a pair's score is computed once per job.
 */
const SCORE_CACHE = new WeakMap();   // fill → Map(region → { n, score })
const MASK_CACHE = new WeakMap();    // region → Map(rectKey → { inner, outer })

async function regionMasks(region, allRegions, W, H, rect, dilatePx, ringPx) {
  let m = MASK_CACHE.get(region);
  if (!m) { m = new Map(); MASK_CACHE.set(region, m); }
  // The neighbour mask depends on the region SET, which grows when the judge
  // names a leftover — so the set size is part of the key.
  const key = `${rect.left},${rect.top},${rect.width},${rect.height},${dilatePx},${ringPx},${allRegions.length}`;
  let masks = m.get(key);
  if (!masks) {
    const neighbours = allRegions.filter(r => r !== region && r.polygons).flatMap(r => r.polygons);
    masks = {
      inner: await rasterizePolys(region.polygons, W, H, rect, dilatePx),
      outer: await rasterizePolys(region.polygons, W, H, rect, dilatePx + ringPx),
      allMask: neighbours.length ? await rasterizePolys(neighbours, W, H, rect, dilatePx) : null,
    };
    m.set(key, masks);
  }
  return masks;
}

/** Cut a rect out of an already-decoded full-frame raw buffer (W×H×3). */
function rectFromRaw(raw, W, rect) {
  const out = Buffer.allocUnsafe(rect.width * rect.height * 3);
  for (let row = 0; row < rect.height; row++) {
    const src = ((rect.top + row) * W + rect.left) * 3;
    raw.copy(out, row * rect.width * 3, src, src + rect.width * 3);
  }
  return out;
}

/** Decode a fill once per assemble() and cut rects out of the raw copy. */
async function fillRaw(fill, rawCache) {
  let raw = rawCache && rawCache.get(fill);
  if (!raw) {
    let img = sharp(fill.buf);
    const m = await img.metadata();
    if (m.width !== fill.width || m.height !== fill.height) img = sharp(await img.resize(fill.width, fill.height, { fit: 'fill', kernel: 'lanczos3' }).toBuffer());
    raw = await img.removeAlpha().raw().toBuffer();
    if (rawCache) rawCache.set(fill, raw);
  }
  return raw;
}

async function scoreFill(origBuf, fill, region, allRegions, W, H, { dilatePx, ringPx, origRaw = null, fillRaws = null }) {
  let perFill = SCORE_CACHE.get(fill);
  if (!perFill) { perFill = new Map(); SCORE_CACHE.set(fill, perFill); }
  const hit = perFill.get(region);
  // Neighbour masks depend on the region set, which grows when the judge
  // names a leftover — a cached score is only valid for the same set size.
  if (hit && hit.n === allRegions.length) return hit.score;

  const rect = regionRect(region.polygons, W, H, ringPx + dilatePx);
  let score = null;
  if (fillCovers(fill, rect)) {
    const { inner, outer, allMask } = await regionMasks(region, allRegions, W, H, rect, dilatePx, ringPx);
    const o = origRaw ? rectFromRaw(origRaw, W, rect) : await rectRaw(origBuf, rect);
    const f = fillRaws
      ? rectFromRaw(await fillRaw(fill, fillRaws), fill.width, { left: rect.left - fill.left, top: rect.top - fill.top, width: rect.width, height: rect.height })
      : await fillRectRaw(fill, rect);
    let ringSum = 0, ringN = 0, inSum = 0, inN = 0;
    for (let i = 0, p = 0; i < inner.length; i++, p += 3) {
      const d = Math.abs(o[p] - f[p]) + Math.abs(o[p + 1] - f[p + 1]) + Math.abs(o[p + 2] - f[p + 2]);
      if (inner[i] > 127) { inSum += d; inN++; }
      else if (outer[i] > 127 && (!allMask || allMask[i] <= 127)) { ringSum += d; ringN++; }
    }
    score = {
      ring: ringN ? ringSum / (3 * ringN) : 999,
      inside: inN ? inSum / (3 * inN) : 0,
      rect,
    };
  }
  perFill.set(region, { n: allRegions.length, score });
  return score;
}

/* --------------------------------------------------------------- assembly */

/**
 * Blend, per region, the best qualifying fill into a copy of the original.
 * Returns { buf (jpeg), cleaned, kept, plan } — plan says which fill served
 * which region and which regions kept the original pixels (and why).
 */
async function assemble(origBuf, regions, fills, W, H, opts = {}) {
  const dilatePx = opts.dilatePx ?? Math.round(Math.max(W, H) * 0.012);
  const featherPx = opts.featherPx ?? Math.round(Math.max(W, H) * 0.006);
  const ringPx = opts.ringPx ?? dilatePx * 3;
  const ringTol = opts.ringTolerance ?? RING_TOLERANCE;
  const changeFloor = opts.changeFloor ?? CHANGE_FLOOR;

  const out = await sharp(origBuf).removeAlpha().raw().toBuffer();
  // One decode of the original serves every (fill, region) pair below; `out`
  // is about to be blended into, so scoring reads a pristine copy.
  const origRaw = Buffer.from(out);
  // Decoded fills live only for this call — a dozen full frames is half a
  // gigabyte, which is fine for one pass and not fine to keep.
  const fillRaws = new Map();
  let cleaned = 0, kept = 0;
  const plan = [];
  for (const region of regions) {
    if (!region.polygons) { plan.push({ label: region.label, kept: 'untraceable' }); kept++; continue; }
    let best = null;
    for (const fill of fills) {
      const s = await scoreFill(origBuf, fill, region, regions, W, H, { dilatePx, ringPx, origRaw, fillRaws });
      if (!s || s.inside < changeFloor) continue;
      if (!best || s.ring < best.ring) best = { fill, ...s };
    }
    if (!best || best.ring > ringTol) {
      plan.push({ label: region.label, kept: best ? `best ring ${best.ring.toFixed(1)} > ${ringTol}` : 'no fill changed this region' });
      kept++; continue;
    }
    // Blend inside the region's feathered mask, rect-locally.
    const rect = best.rect;
    const soft = await feather(await rasterizePolys(region.polygons, W, H, rect, dilatePx), rect, featherPx);
    const f = await fillRectRaw(best.fill, rect);
    for (let i = 0; i < soft.length; i++) {
      const a = soft[i] / 255;
      if (a === 0) continue;
      const row = Math.floor(i / rect.width), col = i % rect.width;
      const p = ((rect.top + row) * W + rect.left + col) * 3;
      const q = i * 3;
      out[p] = out[p] + (f[q] - out[p]) * a;
      out[p + 1] = out[p + 1] + (f[q + 1] - out[p + 1]) * a;
      out[p + 2] = out[p + 2] + (f[q + 2] - out[p + 2]) * a;
    }
    cleaned++;
    plan.push({ label: region.label, ring: +best.ring.toFixed(1), inside: +best.inside.toFixed(0), from: best.fill.name || 'fill' });
  }
  const buf = await sharp(out, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  return { buf, cleaned, kept, plan };
}

/* -------------------------------------------------------------- crop fill */

function cropPrompt(what) {
  return `You are the automated finishing engine of a professional real-estate photography studio. This image is a small CROP of a listing photograph.

Your output is a COPY of this crop with exactly one change: REMOVE ${what}. Where a removed item revealed a surface, reconstruct that surface exactly as it plausibly continues — same material, same colour, same lighting, same grain.

KEEP EVERYTHING ELSE IDENTICAL — every piece of furniture, every surface, every edge, at its exact size, shape and position. Same camera, same framing, same lighting, same colours. Add nothing, extend nothing, resize nothing. This is a copy job with a deletion, not a redecoration.`;
}

/**
 * Generate a crop-local fill for one region. Returns a fill {buf,left,top,
 * width,height,name} whose crop is padded far enough past the region that the
 * ring check evaluates inside it. Colour-locked to the original crop.
 */
/**
 * Escalation ladder for a region's crop attempts. A retry that repeats the same
 * experiment converges on the same failure (that lesson is written on the whole
 * pipeline), so each attempt changes something that plausibly caused the last
 * miss: attempt 2 doubles the context — the measured failure was the model
 * "extending" a cabinet top to fill its view, and a wider crop anchors the
 * geometry it must not invent past; attempt 3 changes the MODEL — the flash
 * fallback has a different failure profile, and a region pro keeps fumbling is
 * exactly where different beats better. Flash gets its wider colour limits; the
 * after-residual check inside lockColour stays the guardrail.
 */
const CROP_LADDER = [
  { padScale: 1, model: undefined, colour: {} },
  { padScale: 2, model: undefined, colour: {} },
  { padScale: 1.4, model: 'gemini-3.1-flash-image', colour: { maxGain: 1.20, minGain: 0.82, maxOffset: 40 } },
];

async function cropFill(deps, apiKey, origBuf, region, W, H, opts = {}) {
  const { generateImage, lockColour } = deps;
  const dilatePx = opts.dilatePx ?? Math.round(Math.max(W, H) * 0.012);
  const ringPx = opts.ringPx ?? dilatePx * 3;
  const rung = CROP_LADDER[Math.min(opts.attempt ?? 0, CROP_LADDER.length - 1)];
  // Pad past ring + feather so the whole evaluation neighbourhood is in-crop,
  // and past that again so the model sees the furniture in context.
  const margin = Math.round((ringPx + dilatePx * 2 + Math.max(W, H) * 0.06) * rung.padScale);
  const rect = regionRect(region.polygons, W, H, margin);
  const cropBuf = await sharp(origBuf).extract(rect).jpeg({ quality: 95 }).toBuffer();
  const genOpts = { imageSize: opts.imageSize || '1K' };
  if (rung.model) genOpts.model = rung.model;
  const gen = await generateImage(apiKey, cropPrompt(region.label), cropBuf.toString('base64'), 'image/jpeg', genOpts);
  let editBuf = Buffer.from(gen.data, 'base64');
  const m = await sharp(editBuf).metadata();
  if (m.width !== rect.width || m.height !== rect.height) {
    editBuf = await sharp(editBuf).resize(rect.width, rect.height, { fit: 'fill', kernel: 'lanczos3' }).jpeg({ quality: 95 }).toBuffer();
  }
  const locked = await lockColour(cropBuf, editBuf, { ...rung.colour });
  return {
    buf: locked.buf, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
    name: `crop${(opts.attempt ?? 0) + 1}:${String(region.label).slice(0, 30)}`, colour: { applied: locked.applied, before: locked.before, after: locked.after },
    model: gen.model || rung.model,
  };
}

/**
 * Trace ONE item from a text description — the audit loop's tool. The scope
 * check (verifyClutterGone) is a second pair of eyes on the finished
 * composite; when it names clutter the segmenter never detected, that finding
 * comes here and becomes a new region for the next round. Without this, a
 * region the segmenter missed could never be filled and the job could never
 * pass its own scope gate.
 */
async function traceOne(deps, apiKey, model, imgB64, mime, description, where) {
  const { geminiGenerateContent } = deps;
  const ask = `In this real-estate photo, find: ${description}${where ? ` (located: ${where})` : ''}. Trace its exact outline. Output ONLY JSON: a list where each entry has "label" and "polygon" — the polygon is a list of [y, x] vertex pairs (normalized 0-1000, 10 to 40 vertices) tracing tightly around the visible object. One entry per separate part. Trace ONLY the described item; do not include any furniture surface it sits on. If it is not visible, output [].`;
  try {
    const res = await askJson(geminiGenerateContent, apiKey, model, imgB64, mime, ask);
    const polygons = (Array.isArray(res) ? res : [])
      .map(r => r && r.polygon)
      .filter(p => Array.isArray(p) && p.length >= 3 &&
        p.every(v => Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= 0 && n <= 1000)));
    if (polygons.length) return { label: description.slice(0, 80), polygons };
  } catch (e) { /* fall through */ }
  return null;
}

/**
 * COVERAGE — the arithmetic behind the masked-first router (2 Sep 2026).
 *
 * Deliberately NOT a model's opinion. The app's scene classifier once rated a
 * lightly-cluttered nursery "too full" (Kyle: "it wasn't that full — a perfect
 * candidate for declutter"), so no model gets to vote on big-job-or-small-job
 * again. This is the shoelace formula over the segmenter's TRACED outlines:
 * what share of the frame is actually clutter, and how large the single
 * biggest item is. Many small items sum small (masked's sweet spot); one dog
 * crate sums big (classic's). Untraced regions are excluded — they cannot be
 * filled, so they stay in the photo whichever path leads.
 *
 * unionPct is a slight over-count when items overlap (areas are summed, not
 * unioned, and capped at 100); that errs toward classic-first, the
 * conservative direction.
 */
function coverage(regions) {
  let sum = 0, largest = 0, name = null;
  for (const r of regions || []) {
    if (!r || !Array.isArray(r.polygons)) continue;
    let area = 0;
    for (const poly of r.polygons) {
      let a = 0;
      for (let i = 0; i < poly.length; i++) {
        const [y1, x1] = poly[i], [y2, x2] = poly[(i + 1) % poly.length];
        a += x1 * y2 - x2 * y1;
      }
      area += Math.abs(a) / 2;            // in (0-1000)^2 units
    }
    const pct = area / 10000;             // → percent of the frame
    sum += pct;
    if (pct > largest) { largest = pct; name = r.label; }
  }
  return { unionPct: +Math.min(100, sum).toFixed(1), largestPct: +largest.toFixed(1), largestLabel: name };
}

module.exports = {
  detectAndTrace, traceOne, regionRect, rasterizePolys, scoreFill, assemble, cropFill, coverage,
  RING_TOLERANCE, CHANGE_FLOOR,
};
