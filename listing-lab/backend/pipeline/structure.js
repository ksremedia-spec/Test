/**
 * Listing Lab — structural verification.
 *
 * WHY THIS EXISTS
 * The compliance judge sees the whole ORIGINAL and the whole CANDIDATE and answers
 * a checklist. On 2026-08-23 it passed a staged great room 3/3 with the check
 * `no_window_door_switch_covered` answered "window openings remain fully
 * unobstructed" — while the candidate had replaced a large window with shiplap and
 * hung a painting over it. Three independent votes all confabulated the same
 * evidence. A wide question over a wide image lets a model narrate compliance it
 * never checked.
 *
 * The fix is not a sterner rule. It is a narrower question:
 *   1. locate each fixed feature in the ORIGINAL as a box,
 *   2. crop that same box out of BOTH images at native resolution,
 *   3. put the two crops side by side and ask about that ONE feature,
 *   4. force the answer into a closed set, not prose.
 * There is nothing else in the frame to talk about, so "it's unchanged" has to be
 * about the thing we asked about.
 *
 * Same idea for arrangement: instead of "would this embarrass a stager", we ask
 * where the focal point is and which way the anchor piece faces.
 */
const sharp = require('sharp');
const { geminiGenerateContent } = require('./gemini');

/* Features worth verifying one by one. Outlets and vents are deliberately absent:
   Kyle graded furniture in front of them as fine, so they are noise here. */
const VERIFY_KINDS = ['window', 'door', 'doorway', 'fireplace', 'built_in', 'stairs', 'wall_tv', 'ceiling_fixture'];

/* A freestanding piece standing in front of these is normal furnishing, not a
   violation — the element is still there and a buyer can still see the room. */
const VIOLATION_VERDICTS = new Set(['covered_by_wall_mounted_object', 'gone', 'changed']);

async function ask(apiKey, model, prompt, images, temperature = 0) {
  const parts = [{ text: prompt }];
  for (const img of images) parts.push({ inline_data: { mime_type: img.mime || 'image/jpeg', data: img.data } });
  const json = await geminiGenerateContent(apiKey, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature, response_mime_type: 'application/json' },
  });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * Locate fixed architectural features in the ORIGINAL as structured boxes.
 * Structured on purpose: the earlier bug where a keep-list regex matched the word
 * "window" inside a shelf's prose description is the reason nothing here is parsed
 * out of a sentence.
 */
async function locateFixed(apiKey, model, imageB64, mime) {
  const prompt = `List every FIXED architectural feature visible in this room photograph — the things that belong to the building and cannot be carried out of it.
Include: windows (each window opening separately), doors, doorways/cased openings, fireplaces, built-in cabinetry/shelving, staircases, wall-mounted TVs, ceiling fixtures and fans.
Do NOT include: furniture, rugs, plants, decor, outlets, vents, or switches.
For each, give a tight bounding box in PERCENT of the frame (x from the left, y from the top).
Respond with ONLY JSON:
{"fixed":[{"name":"large window with white blinds on the right wall","kind":"window","x_from":86,"y_from":5,"x_to":97,"y_to":68}]}
kind must be one of: window, door, doorway, fireplace, built_in, stairs, wall_tv, ceiling_fixture, other.`;
  const v = await ask(apiKey, model, prompt, [{ data: imageB64, mime }]);
  const out = [];
  // The model was asked for PERCENT and, about one answer in thirty, replies
  // in thousandths anyway (e10, 5 Sep 2026: y_to 1000) — which put every
  // pixel-guard box off the frame. One coordinate over 100 means the whole
  // answer is per-mille; scale it back. Values are clamped to the frame.
  const raw = (v.fixed || []).map(f => ({ f, n: k => (typeof f[k] === 'number' ? f[k] : parseFloat(f[k])) }));
  const perMille = raw.some(({ n }) => ['x_from', 'y_from', 'x_to', 'y_to'].some(k => n(k) > 100));
  for (const { f, n: n0 } of raw) {
    const n = k => { const x = n0(k) / (perMille ? 10 : 1); return isFinite(x) ? Math.min(100, Math.max(0, x)) : x; };
    const b = { x_from: n('x_from'), y_from: n('y_from'), x_to: n('x_to'), y_to: n('y_to') };
    if (Object.values(b).some(x => !isFinite(x))) continue;
    if (b.x_to <= b.x_from || b.y_to <= b.y_from) continue;
    out.push({ name: String(f.name || f.kind || 'feature'), kind: String(f.kind || 'other'), ...b });
  }
  return out;
}

/** Crop the same percent-box out of both images and lay them side by side, same scale. */
async function pairCrop(beforeBuf, afterBuf, box, padPct = 6) {
  const meta = await sharp(beforeBuf).metadata();
  const W = meta.width, H = meta.height;
  const px = v => Math.max(0, Math.min(100, v)) / 100;
  // Clamped so the region can NEVER leave the frame (1 Sep 2026): a feature
  // box hugging the right or bottom edge put left at ~W, the min-48 floor then
  // pushed left+width past the frame, and sharp threw 'extract_area: bad
  // extract area' — a FATAL that killed two declutters mid-batch while
  // wearing a Google-outage costume (the 503 text above it matched the
  // retryable regex, so the jobs looped instead of finishing).
  const left = Math.min(Math.floor(px(box.x_from - padPct) * W), Math.max(0, W - 48));
  const top = Math.min(Math.floor(px(box.y_from - padPct) * H), Math.max(0, H - 48));
  const right = Math.ceil(px(box.x_to + padPct) * W);
  const bottom = Math.ceil(px(box.y_to + padPct) * H);
  const width = Math.max(1, Math.min(W - left, Math.max(48, right - left)));
  const height = Math.max(1, Math.min(H - top, Math.max(48, bottom - top)));
  const region = { left, top, width, height };

  // The candidate may come back at a different resolution than the original;
  // normalise it to the original's dimensions first so the same box means the
  // same part of the room in both.
  const afterNorm = await sharp(afterBuf).resize({ width: W, height: H, fit: 'fill' }).toBuffer();
  const scale = Math.min(3, Math.max(1, Math.round(900 / Math.max(width, height))));
  const opts = { width: width * scale, height: height * scale, kernel: 'lanczos3' };
  const a = await sharp(beforeBuf).extract(region).resize(opts).toBuffer();
  const b = await sharp(afterNorm).extract(region).resize(opts).toBuffer();
  const w = width * scale, h = height * scale, gap = 12;
  const composite = await sharp({ create: { width: w * 2 + gap, height: h, channels: 3, background: '#ff0000' } })
    .composite([{ input: a, left: 0, top: 0 }, { input: b, left: w + gap, top: 0 }])
    .jpeg({ quality: 92 }).toBuffer();
  return { data: composite.toString('base64'), mime: 'image/jpeg' };
}

const ELEMENT_PROMPT = (el) => `The image shows the SAME small region of one room twice, at the same scale: BEFORE on the left of the red divider, AFTER on the right.
In the BEFORE crop there is: ${el.name} (a ${el.kind.replace(/_/g, ' ')}).
Find that exact feature in the BEFORE crop. Then look at the same position in the AFTER crop and report what happened to it.

Choose exactly ONE verdict:
- "present" — the feature is still there, fully or nearly fully visible, and looks the same.
- "partly_behind_furniture" — a piece of freestanding furniture (sofa back, headboard, dresser, chair, plant) stands in FRONT of it, but the feature itself is still there and still identifiable above or around that furniture.
- "covered_by_wall_mounted_object" — something hung or mounted ON THE WALL (framed art, mirror, TV, shelf, panelling) now sits over the feature and hides it.
- "gone" — the feature is not in the AFTER crop at all: the area is now plain wall, panelling, or some other surface.
- "changed" — the feature is still there but is materially different: different width or height, different number of panes, different grille pattern, different trim, different style.
- "unclear" — the crop does not let you tell.

Be literal. If the BEFORE crop shows glass and the AFTER crop shows wall or a picture in that same place, the verdict is "gone" or "covered_by_wall_mounted_object" — not "present". Describe what you actually see in each crop before choosing.

OCCLUSION: if part of the feature is HIDDEN in the BEFORE crop behind a freestanding object (a lampshade, plant, furniture, belongings) that the edit removed, judge ONLY the parts that are visible in BEFORE. If those visible parts are unchanged in AFTER, the verdict is "present" — a newly revealed section that plausibly continues the unit's own visible design is reconstruction, not a change. Only call it "changed" if a part that was VISIBLE in BEFORE is different in AFTER.

Respond with ONLY JSON: {"before_shows":"...","after_shows":"...","verdict":"one of the six","confidence":0.0}`;

/**
 * Verify every fixed feature survived. Returns { violations, checked, details }.
 * A suspected violation is re-asked once at temperature 0.3 before it counts, so a
 * single unlucky read cannot fail a good image.
 */
async function verifyFixedElements(apiKey, model, beforeBuf, afterBuf, fixed, opts = {}) {
  const max = opts.max || 8;
  const targets = (fixed || [])
    .filter(f => VERIFY_KINDS.includes(f.kind))
    .map(f => ({ ...f, area: (f.x_to - f.x_from) * (f.y_to - f.y_from) }))
    .sort((a, b) => b.area - a.area)
    .slice(0, max);
  const details = [], violations = [];
  await Promise.all(targets.map(async (el) => {
    let crop;
    try { crop = await pairCrop(beforeBuf, afterBuf, el); }
    catch (e) { details.push({ element: el.name, verdict: 'unclear', note: 'crop failed: ' + e.message }); return; }
    let r = await ask(apiKey, model, ELEMENT_PROMPT(el), [crop], 0);
    let verdict = String(r.verdict || 'unclear');
    if (VIOLATION_VERDICTS.has(verdict)) {
      const r2 = await ask(apiKey, model, ELEMENT_PROMPT(el), [crop], 0.3);
      const v2 = String(r2.verdict || 'unclear');
      // Both reads must agree it is bad. Disagreement downgrades to a logged note.
      if (!VIOLATION_VERDICTS.has(v2)) { details.push({ element: el.name, kind: el.kind, verdict: 'disputed', first: verdict, second: v2, before: r.before_shows, after: r.after_shows }); return; }
      verdict = v2 === verdict ? verdict : v2;
      violations.push(`${el.name}: ${verdict === 'gone' ? 'is missing from the result' : verdict === 'covered_by_wall_mounted_object' ? 'has been covered by something mounted on the wall' : 'has been materially altered'} (before: ${r.before_shows || '—'}; after: ${r.after_shows || '—'})`);
    }
    details.push({ element: el.name, kind: el.kind, verdict, confidence: r.confidence, before: r.before_shows, after: r.after_shows });
  }));
  return { checked: targets.length, violations, details };
}

/* ---------------------------------------------------------------- focal point */

/* A focal point here means a feature furniture is SUPPOSED to point at. A window is
   deliberately NOT one: Kyle graded "a sofa parallel to the window wall is fine",
   and in a small room backing the sofa onto the window is the normal, correct
   arrangement. Treating a window as a focal point turned good staging into a
   failure on the first run of this check. */
const FOCAL_KINDS = new Set(['fireplace', 'media_wall', 'feature_wall']);
const FOCAL_PROMPT = `This is an EMPTY or sparsely furnished room that is about to be staged.
Does this room have a feature that seating MUST be oriented toward — specifically one of:
- "fireplace": a fireplace, with or without a TV above it
- "media_wall": a wall-mounted TV or built-in media wall
- "feature_wall": a deliberate architectural feature wall (stone, panelled, built-in shelving flanking a centre)
A plain window, a view, a doorway, or an ordinary blank wall is NOT one of these. If the room has none of the three, answer exists:false — most rooms genuinely have none, and that is a fine answer.
Respond with ONLY JSON: {"focal_point":"stone fireplace with mounted TV on the back wall","focal_kind":"fireplace","x_from":60,"y_from":34,"x_to":73,"y_to":58,"exists":true}`;

const ANCHOR_PROMPT = (focal, roomType) => `This is a staged ${roomType || 'room'}. The room's focal point is: ${focal.focal_point} — located at x ${focal.x_from}%–${focal.x_to}%, y ${focal.y_from}%–${focal.y_to}% of the frame (x from the left, y from the top).

Identify the ANCHOR piece: the largest primary seating or sleeping piece — the sofa or sectional in a living room, the bed in a bedroom, the desk in an office, the table in a dining room.
Then decide which way a person USING that piece would be looking.

Choose exactly ONE verdict:
- "faces_focal_point" — a person seated on/at it looks toward the focal point.
- "angled_toward" — not square to it, but the focal point is within their view and the grouping clearly centres on it.
- "perpendicular" — the focal point is off to their side; the piece neither faces it nor turns away.
- "back_to_focal_point" — a person seated on/at it has the focal point BEHIND them.
- "no_anchor" — no such piece is present.

Then answer separately: does the seating form a conversation group centred on the focal point, or is it scattered / pushed against one wall / facing empty floor?

Describe where the anchor piece is and which way it points before choosing.
Respond with ONLY JSON: {"anchor":"beige three-seat sofa at x 45-75%, y 60-80%","facing":"the fireplace is behind the sofa","verdict":"one of the five","grouping":"centred|scattered|against_wall|facing_nothing","confidence":0.0}`;

/**
 * Does the staging actually orient itself to the room?
 * `back_to_focal_point` is a hard fail: putting the sofa's back to the fireplace is
 * the single arrangement error Kyle has rejected most often, and the design score
 * has never reliably caught it (his rejects still score 7–9). This asks the one
 * geometric question instead of asking for taste.
 */
async function verifyFocalPoint(apiKey, model, originalB64, mime, afterB64, afterMime, roomType, votes = 3) {
  const focal = await ask(apiKey, model, FOCAL_PROMPT, [{ data: originalB64, mime }], 0);
  if (!focal || focal.exists === false || !focal.focal_point) return { skipped: true, reason: 'no orient-toward feature in this room' };
  // Only a fireplace / media wall / feature wall can fail a candidate. Anything
  // else the model volunteers (a window, a view, a doorway) is not a focal point.
  if (!FOCAL_KINDS.has(String(focal.focal_kind || '').toLowerCase()))
    return { skipped: true, reason: `focal candidate "${focal.focal_point}" is not an orient-toward feature`, focal };
  const reads = await Promise.all(Array.from({ length: votes }, (_, i) =>
    ask(apiKey, model, ANCHOR_PROMPT(focal, roomType), [{ data: afterB64, mime: afterMime }], i === 0 ? 0 : 0.4).catch(() => ({}))));
  const tally = {};
  for (const r of reads) { const v = String(r.verdict || 'unclear'); tally[v] = (tally[v] || 0) + 1; }
  const backs = tally.back_to_focal_point || 0;
  const violations = [];
  if (backs > votes / 2) {
    const ev = reads.find(r => r.verdict === 'back_to_focal_point') || {};
    violations.push(`The anchor piece has its back to the room's focal point (${focal.focal_point}). ${ev.anchor || ''} ${ev.facing || ''}`.trim());
  }
  const away = reads.filter(r => r.grouping && r.grouping !== 'centred').length;
  const minor = [];
  if (!violations.length && away > votes / 2) {
    const ev = reads.find(r => r.grouping && r.grouping !== 'centred') || {};
    minor.push(`Seating grouping reads as "${ev.grouping}" rather than centred on ${focal.focal_point}.`);
  }
  return { skipped: false, focal, tally, violations, minor, reads };
}

/* ------------------------------------------------------- focal point PROXIMITY */

/* WHY THIS IS SEPARATE FROM verifyFocalPoint
   On 2026-08-25 Kyle graded a Coastal great room a PASS on orientation and then
   said: "I do wish it would have pushed everything closer to the TV and fireplace,
   it's pretty far off, no one would place it that way." Two different defects wear
   the same clothes:
     - verifyFocalPoint asks WHICH WAY the anchor points.
     - this asks HOW FAR AWAY the whole grouping sits.
   A sofa can face the fireplace perfectly from across an acre of empty floor.

   Adding "pull the seating in close" to the generator prompt moved one candidate
   of three. That is a nudge, not a guarantee — the same reason the window rule
   needed a checker rather than a sterner sentence.

   SEATING ROOMS ONLY. In a bedroom the bed goes on the longest uninterrupted wall
   and its distance from a side-wall TV is not a defect; Kyle has passed those
   repeatedly. Applying a distance rule there would manufacture false positives in
   exactly the room type where the arrangement is already correct. */
const PROXIMITY_ROOMS = new Set(['living room', 'basement / rec room', 'basement', 'rec room', 'family room', 'great room']);

const PROXIMITY_PROMPT = (focal, roomType) => `This is a staged ${roomType || 'living room'}. The room's focal point is: ${focal.focal_point} — located at x ${focal.x_from}%–${focal.x_to}%, y ${focal.y_from}%–${focal.y_to}% of the frame (x from the left, y from the top).

Ignore which DIRECTION the furniture faces. This question is only about DISTANCE.

Look at the floor between the focal point and the nearest edge of the seating group (sofa, chairs, coffee table, rug — whichever comes closest to the focal point). Judge the gap the way someone standing in the room would.

Reference for scale: in a normally staged living room a person on the sofa is roughly 8 to 12 feet from the fireplace — close enough to talk across the coffee table and feel the fire. A gap of more than about 15 feet of bare floor, with no rug and no furniture bridging it, means the seating has been left stranded away from the focal point.

Choose exactly ONE verdict:
- "gathered" — the seating group sits up around the focal point at normal living distance.
- "slightly_back" — pulled back further than ideal, but the focal point and the seating still read as one arrangement.
- "marooned" — a wide expanse of empty floor separates them; the focal point reads as belonging to a different part of the room than the furniture.
- "no_seating" — there is no seating group in this room.

State the estimated gap in feet and describe what is on the floor between them before choosing.
Respond with ONLY JSON: {"nearest_piece":"jute rug edge at x 40-70%, y 62-90%","between":"bare hardwood, nothing on it","gap_feet":18,"verdict":"one of the four","confidence":0.0}`;

/**
 * Is the seating group actually gathered around the focal point, or stranded from it?
 *
 * Fails only on `marooned`, and only on a majority of votes, and only after the
 * suspicion survives a second independent read — the same belt-and-braces the
 * per-element checker uses. `slightly_back` is deliberately NOT a failure: Kyle
 * passed the Coastal great room while wishing it were closer, so "further than I'd
 * like" and "wrong" are different verdicts and only the second one may reject a
 * paying customer's image.
 */
async function verifyFocalProximity(apiKey, model, originalB64, mime, afterB64, afterMime, roomType, votes = 3) {
  if (!PROXIMITY_ROOMS.has(String(roomType || '').toLowerCase()))
    return { skipped: true, reason: `proximity is not judged for room type "${roomType || 'unknown'}"` };
  const focal = await ask(apiKey, model, FOCAL_PROMPT, [{ data: originalB64, mime }], 0);
  if (!focal || focal.exists === false || !focal.focal_point) return { skipped: true, reason: 'no orient-toward feature in this room' };
  if (!FOCAL_KINDS.has(String(focal.focal_kind || '').toLowerCase()))
    return { skipped: true, reason: `focal candidate "${focal.focal_point}" is not an orient-toward feature`, focal };

  const read = () => ask(apiKey, model, PROXIMITY_PROMPT(focal, roomType), [{ data: afterB64, mime: afterMime }], 0.3).catch(() => ({}));
  let reads = await Promise.all(Array.from({ length: votes }, read));
  const count = rs => rs.filter(r => String(r.verdict) === 'marooned').length;
  const violations = [];
  if (count(reads) > votes / 2) {
    // Re-ask before it counts. One unlucky read must not sink a good image.
    const second = await Promise.all(Array.from({ length: votes }, read));
    if (count(second) > votes / 2) {
      const ev = [...reads, ...second].find(r => r.verdict === 'marooned') || {};
      violations.push(`The seating group is stranded from the room's focal point (${focal.focal_point})` +
        `${ev.gap_feet ? ` — roughly ${ev.gap_feet} ft of ${ev.between || 'empty floor'} between them` : ''}.` +
        `${ev.nearest_piece ? ` Nearest piece: ${ev.nearest_piece}.` : ''}`);
    }
    reads = reads.concat(second);
  }
  const tally = {};
  for (const r of reads) { const v = String(r.verdict || 'unclear'); tally[v] = (tally[v] || 0) + 1; }
  const gaps = reads.map(r => Number(r.gap_feet)).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  return { skipped: false, focal, tally, violations, reads, medianGapFeet: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null };
}

/* ------------------------------------------------------- did anything happen */

const REMOVAL_PROMPT = `Two photographs of the same room. Image 1 is BEFORE, image 2 is AFTER a decluttering edit.

List the objects that are clearly present in image 1 and clearly ABSENT in image 2 — things that were taken away. Boxes, laundry, toiletries, cables, worktop appliances, toys, bins, paperwork, personal effects, small furniture.

Ignore everything else. Do not list changes in lighting, colour, sharpness, grain or camera position: the AFTER image is a full re-render, so the whole frame differs slightly even when nothing was taken away. Only list objects that are GONE.

If nothing was taken away, answer with an empty list. That is a normal and useful answer.

Respond with ONLY JSON: {"removed":["cardboard box on the floor","laundry pile on the bed"],"count":2}`;

/**
 * Did the edit actually remove anything?
 *
 * WHY THIS IS A VISION CALL AND NOT A PIXEL COMPARISON
 * The obvious implementation — diff the two frames and see whether much moved —
 * was built, measured, and thrown away on 25 Aug 2026. Measured against real
 * output:
 *
 *   empty room "decluttered", nothing removed  → 64.0% of pixels changed
 *   cluttered bedroom genuinely decluttered    → 65.8% of pixels changed
 *
 * Nano Banana re-renders the entire photograph on every job, so pixel difference
 * says nothing whatsoever about whether an object was taken away. A check that
 * cannot separate those two cases is worse than no check, because it looks like
 * diligence in the audit record.
 *
 * So ask the question that is actually being asked, with both frames in view and
 * a closed answer: what is gone?
 */
async function verifyRemoval(apiKey, model, beforeB64, beforeMime, afterB64, afterMime, votes = 2) {
  const reads = await Promise.all(Array.from({ length: votes }, (_, i) =>
    ask(apiKey, model, REMOVAL_PROMPT,
      [{ data: beforeB64, mime: beforeMime }, { data: afterB64, mime: afterMime }],
      i === 0 ? 0 : 0.3).catch(() => null)));

  const counts = reads.filter(Boolean).map(r => Array.isArray(r.removed) ? r.removed.length : (Number(r.count) || 0));
  if (!counts.length) return { removedAnything: true, reason: 'could not tell — not blocking delivery' };

  // Majority must see something gone. A single vote seeing one item is not
  // enough to call it work, and a single vote seeing nothing is not enough to
  // call it a no-op.
  const sawSomething = counts.filter(c => c > 0).length;
  const removedAnything = sawSomething > counts.length / 2;
  const items = (reads.find(r => r && Array.isArray(r.removed) && r.removed.length)?.removed || []).slice(0, 6);
  return { removedAnything, votes: counts, items };
}

module.exports = { locateFixed, verifyFixedElements, verifyFocalPoint, verifyFocalProximity, verifyRemoval, pairCrop, VERIFY_KINDS, PROXIMITY_ROOMS };
