/**
 * Listing Lab — the region close-up review.
 *
 * WHY (Kyle's ghosting delivery, 2 Sep 2026, and the failed instrument that
 * followed). A masked-path ghost — the smudged wall and mottled table the
 * owner called "insane" — occupies a few percent of the frame, and the
 * whole-frame judge missed it in one measurement run out of four. Arithmetic
 * missed it too, and honestly: a plausible-looking smudge is statistically
 * tame; "this surface looks wrong" is a semantic call. So this is NOT a new
 * judge and NOT new arithmetic — it is the same ghost question the judge
 * already owns, asked with proper evidence: close-up crops of exactly the
 * regions the masked path edited, where a smudge fills the frame instead of
 * hiding in a bedroom.
 *
 * One flash call per masked delivery candidate, all regions batched. The
 * masked path hands its own region boxes (box_2d, normalized 0-1000); each
 * region contributes a BEFORE crop (original) and an AFTER crop (candidate).
 */
const sharp = require('sharp');
const { geminiGenerateContent } = require('./gemini');

const PAD = 0.30;       // context padding around each box
const CROP_W = 448;     // crop width sent to the judge

async function cropB64(buf, box, meta) {
  // box_2d = [ymin, xmin, ymax, xmax] normalized 0-1000.
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
 * Review each edited region up close. Returns
 *   { ok, verdicts: [{n, label, verdict, what}], residue: [labels…] }
 * verdict ∈ clean | residue | still_present. `ok` is false when any region
 * shows residue or a still-present item.
 */
async function reviewRegions(apiKey, model, origBuf, candBuf, regions) {
  const usable = (regions || []).filter(r => Array.isArray(r.box_2d) && r.box_2d.length === 4);
  if (!usable.length) return { ok: true, skipped: 'no regions', verdicts: [] };
  const [om, cm] = await Promise.all([sharp(origBuf).metadata(), sharp(candBuf).metadata()]);
  const parts = [{
    text: `You are inspecting an AI declutter up close. For each numbered region below, the BEFORE crop (from the original photo) shows items that were supposed to be REMOVED, and the AFTER crop shows the same spot in the edited result. Furniture and fixtures visible in a crop may be KEEPERS — only the removed items and the surface where they stood are under review.

For EACH region answer exactly one verdict:
- "clean": the removed items are fully gone and the revealed surface (wall, floor, table top, shelf) looks like real, continuous surface — matching texture, no marks where things stood.
- "residue": something was left behind by the erase — a smudge or darker/lighter patch on the wall or floor, mottled or noisy texture on a surface, a faint outline or shadow of the removed item, a blur, a half-erased fragment, a cord or piece of the item still visible. CHECK THE EDGES TOO: where the removed item stood against a door, door frame, baseboard, trim, cabinet or wall corner, that edge must still be a crisp straight edge — a softened, wavy, doubled, smeared or bent edge, a door panel or frame that loses its line where the item was, is residue (the owner's grade, 4 Sep 2026: a delivered kitchen was failed for exactly that on a door).
- "trace": there IS a mark left by the erase, but a person looking at the full photograph would not notice it — a faint softness, a tiny speck, a hairline. Recorded, never fatal (the owner's ruling, 4 Sep 2026).
- "still_present": the item is simply still there, essentially unremoved.

NAME IT BEFORE YOU CALL IT RESIDUE (the owner's grades, 4 Sep 2026: a delivered kitchen was refused over a "metal fragment" that was the sink's sprayer nozzle, and a bedroom over a "stray line" that was the front edge of the shelf itself). For anything you are about to call residue or a fragment, first say WHAT THE THING IS. A faucet, sprayer hose, shelf edge, bracket, hinge, outlet, switch, vent, trim, grout line, cord of a kept device, or any part of the room or its furniture is a FIXTURE — it is "clean", however odd it looks at crop scale. If you cannot say what it is, it is not residue: answer "trace".

Look hard at the surfaces: at this crop scale a smear the whole-photo view would hide fills the image. BUT apply a NORMAL-VIEWING bar to "residue": it must be something a person looking at the full photograph would notice — an obvious smudge, outline, mottled patch, or fragment. A pixel-level blemish, mild texture softness, or a mark you can only see because the crop magnifies it is "trace", not "residue". "residue" is reserved for what would make a buyer or agent stop and look twice at the full photograph. You are protecting a real-estate photo, not pixel-peeping. AND THE CORD RULE (the owner's standing rule): a cord, cable, wire or charger on its own — crisp and simply still there — is NEVER "residue" and never fails a region; answer "clean" and mention it in "what". Only a HALF-ERASED cord (grey squiggles, smears where a cord was partially removed) is residue. Respond ONLY with JSON: {"regions":[{"n":1,"verdict": "clean|trace|residue|still_present","what":"short description"}]}. Include every region exactly once.` }];
  let n = 0;
  for (const r of usable) {
    n++;
    parts.push({ text: `REGION ${n} — removed: ${String(r.label || 'item').slice(0, 80)}. BEFORE:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await cropB64(origBuf, r.box_2d, om) } });
    parts.push({ text: `REGION ${n} AFTER:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await cropB64(candBuf, r.box_2d, cm) } });
  }
  const json = await geminiGenerateContent(apiKey, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  let out; try { out = JSON.parse(text); } catch { return { ok: true, skipped: 'unparseable answer', verdicts: [] }; }
  const verdicts = (Array.isArray(out.regions) ? out.regions : []).map(v => ({
    n: v.n, verdict: v.verdict, what: String(v.what || '').slice(0, 120),
    label: usable[(v.n || 1) - 1] ? String(usable[(v.n || 1) - 1].label || '').slice(0, 60) : null,
  }));
  /**
   * DIVISION OF LABOUR (3 Sep 2026, measured on the golden set): only
   * "residue" is fatal here. A "still_present" item is a LEFTOVER, and
   * leftover severity belongs to the whole-frame judge's 5c — the category
   * exceptions (a fan is minor), the size allowance, the prominence rules
   * all need full-frame context a crop doesn't have. First mirror run made
   * still_present fatal and killed three owner-passed frames over box fans
   * he'd already ruled minor. The review is the ghost specialist; it reports
   * leftovers as notes and kills only erase residue.
   */
  let bad = verdicts.filter(v => v.verdict === 'residue');
  /**
   * THE FULL-FRAME CONFIRMATION (the owner's ruling, 4 Sep 2026). Told to
   * apply a normal-viewing bar, the crop review still called "a paper note
   * outline on the fridge" and "a dark smudge on the wall" residue on a
   * kitchen the owner delivered without a second look — at 448px a crop
   * cannot tell a mark from a blemish, because it has no idea how small it
   * is. So a residue verdict is not final until the same spot is looked at
   * at the size a buyer sees it — a window of the candidate at 1024px wide,
   * unmagnified (see the viewing-scale window below). Residue that does not
   * show at that size becomes "trace" — recorded, never fatal. One extra
   * call, only when something was called residue; a clean review costs
   * nothing more.
   */
  if (bad.length) {
    try {
      const confirmed = await confirmAtFullFrame(apiKey, model, candBuf, cm, bad.map(v => ({ ...v, box_2d: usable[(v.n || 1) - 1].box_2d })), origBuf, om);
      for (const v of bad) {
        const c = confirmed.get(v.n);
        if (c && c.visible === false) { v.verdict = 'trace'; v.what = `${v.what} (at viewing scale ${c.rating}/10: ${c.why})`.slice(0, 160); v.demoted = true; }
      }
      bad = verdicts.filter(v => v.verdict === 'residue');
    } catch { /* an unavailable confirmation leaves the verdicts as given */ }
  }
  const noted = verdicts.filter(v => v.verdict === 'still_present');
  const traces = verdicts.filter(v => v.verdict === 'trace');
  // Each residue line carries WHERE in the frame it sits (from the region's
  // box), so a chained retry can be told "the discoloured floor patch in the
  // lower left" rather than five identical "boxes and bags" lines that
  // collapse into one (e21, 5 Sep 2026).
  const where = (v) => { const b = usable[(v.n || 1) - 1] && usable[(v.n || 1) - 1].box_2d; return Array.isArray(b) ? ` (${whereInFrame(b)})` : ''; };
  return { ok: bad.length === 0, verdicts,
    residue: bad.map(v => `${v.label || 'region ' + v.n}${where(v)}: ${v.verdict}${v.what ? ' — ' + v.what : ''}`),
    leftovers: noted.map(v => `${v.label || 'region ' + v.n}: still present${v.what ? ' — ' + v.what : ''}`),
    traces: traces.map(v => `${v.label || 'region ' + v.n}: trace${v.what ? ' — ' + v.what : ''}`) };
}

/**
 * THE VIEW THROUGH THE OPENINGS (5 Sep 2026). e27: the model "decluttered"
 * the bedroom seen through a doorway at the back of a living room — blue
 * walls to beige, the bed gone — and two judges passed the photograph,
 * because at whole-frame scale a doorway is a few hundred pixels and the
 * room in front of it was perfect. The catalogued fixed openings (doorways,
 * open doors, windows) already carry boxes; this looks through each one up
 * close and asks a single question: is it the same space beyond? Tidying is
 * allowed; a different wall colour, floor, fixture or missing furniture is
 * a MAJOR change. One call, run beside the judge, only when openings exist.
 * Returns { ok, verdicts: [{n, name, verdict, what}], changed: [text…] }.
 */
async function reviewOpenings(apiKey, model, origBuf, candBuf, fixedElements) {
  const openings = (fixedElements || []).filter(f => /doorway|door|window|opening|arch|pass-?through|stair/i.test(`${f.kind} ${f.name}`)
    && [f.x_from, f.x_to, f.y_from, f.y_to].every(Number.isFinite) && (f.x_to - f.x_from) >= 3 && (f.y_to - f.y_from) >= 3).slice(0, 8);
  if (!openings.length) return { ok: true, skipped: 'no openings', verdicts: [] };
  const [om, cm] = await Promise.all([sharp(origBuf).metadata(), sharp(candBuf).metadata()]);
  const parts = [{
    text: `You are inspecting an AI declutter of a real-estate photograph, looking THROUGH its openings. For each numbered opening below — a doorway, an open door, an archway or a window — the BEFORE crop is from the original photograph and the AFTER crop is the same spot in the edited result. The declutter was allowed to remove loose personal items ANYWHERE in the photograph, including in the space seen through the opening: clothes, boxes, bags, bins, toiletries, papers, cords. It was NOT allowed to change the space itself.
Answer for each opening: is the space seen through it the SAME space? Same wall colour and finish, same floor, same ceiling, same doors, trim, windows and fixtures beyond, same furniture (a bed, dresser, table, sofa, appliance) in the same places, same view out of a window (a yard stays a yard; a neighbouring house stays). A made bed, a cleared table, an emptied shelf or a removed pile is "same". A wall that changed colour, a floor that changed material, furniture that vanished or appeared, a room that became a different room, a door that opened or closed, a window view that changed, an opening that became a wall, or a wall that became an opening is "changed". A closed door whose panel is unchanged is "same". If the crop is too small or dark to tell, answer "same" — you are catching a redrawn space, not pixel noise.
Respond ONLY with JSON: {"openings":[{"n":1,"verdict":"same|changed","what":"one short phrase — for changed, say what differs"}]}. Include every opening exactly once.` }];
  let n = 0;
  const toBox = f => [f.y_from, f.x_from, f.y_to, f.x_to].map(v => Math.max(0, Math.min(1000, v * 10)));
  for (const f of openings) {
    n++;
    parts.push({ text: `OPENING ${n} — ${String(f.name || f.kind).slice(0, 80)}. BEFORE:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await cropB64(origBuf, toBox(f), om) } });
    parts.push({ text: `OPENING ${n} AFTER:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await cropB64(candBuf, toBox(f), cm) } });
  }
  const json = await geminiGenerateContent(apiKey, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, response_mime_type: 'application/json' },
  });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  let out; try { out = JSON.parse(text); } catch { return { ok: true, skipped: 'unparseable answer', verdicts: [] }; }
  const verdicts = (Array.isArray(out.openings) ? out.openings : []).map(v => ({
    n: v.n, verdict: /^changed$/i.test(String(v.verdict || '')) ? 'changed' : 'same', what: String(v.what || '').slice(0, 120),
    name: openings[(v.n || 1) - 1] ? String(openings[(v.n || 1) - 1].name || openings[(v.n || 1) - 1].kind).slice(0, 60) : 'opening ' + v.n,
  }));
  const changed = verdicts.filter(v => v.verdict === 'changed');
  return { ok: changed.length === 0, verdicts, changed: changed.map(v => `${v.name}: ${v.what || 'the space beyond is different'}`) };
}

/** A plain-words position for a box_2d ([ymin, xmin, ymax, xmax], 0-1000). */
function whereInFrame(b) {
  const cy = (b[0] + b[2]) / 2, cx = (b[1] + b[3]) / 2;
  const row = cy < 333 ? 'upper' : cy < 667 ? 'middle' : 'lower';
  const col = cx < 333 ? 'left' : cx < 667 ? 'centre' : 'right';
  return row === 'middle' && col === 'centre' ? 'centre of the frame' : `${row} ${col} of the frame`;
}

const VIEW_W = +(process.env.VIEW_W || 1024);   // roughly what a listing photo is viewed at
const WIN_W = 512, WIN_H = 384;                    // the window a buyer's eye takes in around a spot, at that scale
const NOTICEABLE_MIN = +(process.env.NOTICEABLE_MIN || 5);   // rating at viewing scale below which residue is a trace

/**
 * THE VIEWING-SCALE WINDOW. The close-up crop magnifies a region three to
 * five times; a mark that fills a 448px crop can be a few pixels wide on the
 * photograph a buyer sees. A blind sweep of the whole frame was tried first
 * and could not find even the "insane" ghosting of 2 Sep 2026 at viewing
 * size — the model does not find faults it is not asked about. So the
 * question stays pointed, but the EVIDENCE changes: the candidate is scaled
 * to viewing size and a fixed 512x384 window is cut around the accused
 * spot with NO magnification — exactly the pixels a buyer would be looking
 * at. The same window from the original goes alongside, so "what was there"
 * is not left to memory. Returns Map n → {visible, why}.
 */
async function windowB64(buf, meta, box) {
  const scale = VIEW_W / meta.width;
  const W = VIEW_W, H = Math.round(meta.height * scale);
  const [y0, x0, y1, x1] = box;
  const cx = (x0 + x1) / 2000 * W, cy = (y0 + y1) / 2000 * H;
  const w = Math.min(W, Math.max(WIN_W, Math.round((x1 - x0) / 1000 * W * 1.5)));
  const h = Math.min(H, Math.max(WIN_H, Math.round((y1 - y0) / 1000 * H * 1.5)));
  const left = Math.max(0, Math.min(W - w, Math.round(cx - w / 2)));
  const top = Math.max(0, Math.min(H - h, Math.round(cy - h / 2)));
  const out = await sharp(buf).resize({ width: W }).extract({ left, top, width: w, height: h }).jpeg({ quality: 90 }).toBuffer();
  return out.toString('base64');
}

async function confirmAtFullFrame(apiKey, model, candBuf, meta, items, origBuf, origMeta) {
  const parts = [{ text: `These are windows cut from an AI-decluttered real-estate photograph at the size a home buyer sees it on a listing — NOT magnified. A magnified close-up review flagged a mark left by the erase in each one. For each numbered window, look at it as a buyer scrolling a listing would and rate how NOTICEABLE the flagged mark is at this size on a 0-10 scale: 0 = nothing there at this size; 2 = you can find it only because you were told where to look, a slight tone difference or softness; 5 = a mild blemish a careful viewer might catch; 8 = an obvious smudge, discoloured patch, ghost outline, half-erased object or warped edge that a buyer or agent scrolling the listing would stop on; 10 = unmistakable. Be honest about faintness: most flagged marks at this size are 1-3, and the photograph is sellable with them. Judge only the flagged mark. Respond ONLY with JSON: {"windows":[{"n":1,"noticeable":0-10,"why":"one short phrase"}]}` }];
  for (const v of items) {
    parts.push({ text: `WINDOW ${v.n} — flagged: ${String(v.what || v.label || 'mark').slice(0, 120)}. BEFORE (original):` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await windowB64(origBuf, origMeta, v.box_2d) } });
    parts.push({ text: `WINDOW ${v.n} AFTER (edited):` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await windowB64(candBuf, meta, v.box_2d) } });
  }
  const json = await geminiGenerateContent(apiKey, model, { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, response_mime_type: 'application/json' } });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  const out = JSON.parse(text);
  const m = new Map();
  for (const w of (Array.isArray(out.windows) ? out.windows : [])) { const r = Number(w.noticeable); m.set(w.n, { visible: !Number.isFinite(r) || r >= NOTICEABLE_MIN, rating: r, why: String(w.why || '').slice(0, 80) }); }
  return m;
}

module.exports = { reviewRegions, confirmAtFullFrame, reviewOpenings };
