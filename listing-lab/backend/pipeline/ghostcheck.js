/**
 * Listing Lab — the ghost check. Deterministic residue detection in edited
 * regions.
 *
 * WHY (3 Sep 2026). Kyle's grading found a delivered declutter with "insane"
 * ghosting, and a re-run of the same frame delivered clean — the judge's ghost
 * rule caught the bad roll in three measurement runs out of four. A ghost is
 * not a matter of opinion, though, and it can only live where the masked path
 * cut: every other pixel is the customer's untouched photograph. So this
 * instrument goes to each edited region and MEASURES.
 *
 * THE MEASUREMENT. A clean erase leaves the region reading like the surface
 * around it — carpet like carpet, wall like wall. A ghost (or an object left
 * behind) is residual edge structure the surrounding surface does not have.
 * For each region:
 *
 *   residue = (edgeDensity(candidate interior) - edgeDensity(candidate ring))
 *           / (edgeDensity(original interior)  - edgeDensity(candidate ring))
 *
 * 0 = the object's structure is fully gone (interior now reads like the ring);
 * 1 = the object's structure is fully still there. Smears score in between.
 * The ring is untouched original surface immediately around the cut, so it is
 * the ground truth for "what clean looks like here".
 *
 * Regions come from the caller (the masked path knows its own rectangles); a
 * fallback derives them by pixel-diffing original vs candidate, which is exact
 * for masked output because everything outside the cuts is byte-identical
 * surface. The delivery watermark corner is excluded from derivation.
 *
 * An instrument, not a judge: no model call, no cost, nothing to sweet-talk.
 */
const sharp = require('sharp');

const W = 1024; // working width; height follows aspect

async function grey(buf, blur = 0) {
  const meta = await sharp(buf).metadata();
  const h = Math.round(meta.height * W / meta.width);
  let p = sharp(buf).greyscale().resize(W, h, { fit: 'fill' });
  if (blur) p = p.blur(blur);
  const { data } = await p.raw().toBuffer({ resolveWithObject: true });
  return { data, w: W, h };
}

function sobelDensity(img, x0, y0, x1, y1, exclude = null) {
  const { data, w, h } = img;
  x0 = Math.max(1, x0); y0 = Math.max(1, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (exclude && x >= exclude[0] && x < exclude[2] && y >= exclude[1] && y < exclude[3]) continue;
      const i = y * w + x;
      const gx = -data[i - w - 1] - 2 * data[i - 1] - data[i + w - 1] + data[i - w + 1] + 2 * data[i + 1] + data[i + w + 1];
      const gy = -data[i - w - 1] - 2 * data[i - w] - data[i - w + 1] + data[i + w - 1] + 2 * data[i + w] + data[i + w + 1];
      sum += Math.abs(gx) + Math.abs(gy); n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Derive edit regions by diff (fallback / bench use). Cell-grid clustering:
 * mark 16px cells whose mean absolute difference exceeds a threshold, merge
 * adjacent cells into rectangles. The top-left watermark band is ignored.
 */
function deriveEditRegions(a, b, { cell = 16, minDiff = 12, minCells = 4 } = {}) {
  const w = a.w, h = Math.min(a.h, b.h);
  const cw = Math.floor(w / cell), ch = Math.floor(h / cell);
  const hot = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let s = 0;
      for (let y = 0; y < cell; y += 2) for (let x = 0; x < cell; x += 2) {
        const i = (cy * cell + y) * w + cx * cell + x;
        s += Math.abs(a.data[i] - b.data[i]);
      }
      const mean = s / ((cell / 2) * (cell / 2));
      // Watermark band: top-left 30% x 8%.
      const wm = (cx * cell) < w * 0.30 && (cy * cell) < h * 0.08;
      hot[cy * cw + cx] = (!wm && mean > minDiff) ? 1 : 0;
    }
  }
  // Merge into rectangles by flood fill over the cell grid.
  const seen = new Uint8Array(cw * ch); const rects = [];
  for (let i = 0; i < hot.length; i++) {
    if (!hot[i] || seen[i]) continue;
    const stack = [i]; seen[i] = 1;
    let minX = cw, minY = ch, maxX = 0, maxY = 0, count = 0;
    while (stack.length) {
      const j = stack.pop(); const cy = Math.floor(j / cw), cx = j % cw;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy); count++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const k = ny * cw + nx;
        if (hot[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (count >= minCells) rects.push([minX * cell, minY * cell, (maxX + 1) * cell, (maxY + 1) * cell]);
  }
  return rects;
}

/**
 * Score residue per region. Returns { regions: [{rect, residue, areaPct}],
 * worst, dirtyPct } — `worst` is the max residue among regions of meaningful
 * size, `dirtyPct` the share of edited area with residue above the threshold.
 */
async function ghostScore(origBuf, candBuf, rects = null, { residueMax = null } = {}) {
  const [A, B] = await Promise.all([grey(origBuf), grey(candBuf)]);
  let regions = rects;
  if (!regions) {
    // Derivation uses BLURRED copies: original and delivery may have been
    // resampled from different resolutions, and resampling texture would
    // otherwise read as change everywhere. Real edits survive a 2px blur;
    // resampling noise does not. (Production passes real rects instead.)
    const [Ab, Bb] = await Promise.all([grey(origBuf, 2), grey(candBuf, 2)]);
    regions = deriveEditRegions(Ab, Bb, { minDiff: 16 });
  }
  const out = [];
  for (const [x0, y0, x1, y1] of regions) {
    const rw = x1 - x0, rh = y1 - y0;
    const pad = Math.max(8, Math.round(Math.min(rw, rh) * 0.35));
    const ring = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    const ringD = sobelDensity(B, ring[0], ring[1], ring[2], ring[3], [x0, y0, x1, y1]);
    const candIn = sobelDensity(B, x0, y0, x1, y1);
    const origIn = sobelDensity(A, x0, y0, x1, y1);
    const objSignal = origIn - ringD;
    const residue = objSignal > 4 ? Math.max(0, Math.min(1.5, (candIn - ringD) / objSignal)) : 0;
    out.push({ rect: [x0, y0, x1, y1], residue: +residue.toFixed(3), areaPct: +((rw * rh) / (A.w * A.h) * 100).toFixed(2) });
  }
  const meaningful = out.filter(r => r.areaPct >= 0.05);
  const worst = meaningful.length ? Math.max(...meaningful.map(r => r.residue)) : 0;
  const max = residueMax ?? GHOST_RESIDUE_MAX;
  const dirty = meaningful.filter(r => r.residue > max);
  const dirtyPct = +dirty.reduce((s, r) => s + r.areaPct, 0).toFixed(2);
  return { regions: out, worst: +worst.toFixed(3), dirty: dirty.length, dirtyPct, ok: dirty.length === 0, max };
}

/** Threshold — tuned on Kyle's graded triple (see the bench in git history). */
const GHOST_RESIDUE_MAX = parseFloat(process.env.GHOST_RESIDUE_MAX || '0.45');

module.exports = { ghostScore, deriveEditRegions, GHOST_RESIDUE_MAX };
