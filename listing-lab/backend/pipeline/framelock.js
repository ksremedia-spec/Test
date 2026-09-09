/**
 * Listing Lab — the frame lock. Deterministic camera-change detection.
 *
 * WHY THIS EXISTS (2 Sep 2026). Kyle graded all 21 of the day's twilights and
 * failed seven delivered ones — four of them for the same defect: the model
 * RE-IMAGINED the photograph. Same house, different camera — larger in frame,
 * shifted, windows redrawn, a canopy thinned. The judge's camera rule was
 * already "always MAJOR — check first" and it passed every one of them, two
 * votes each. Words had their chance. This is arithmetic instead: an
 * instrument in the family of the pixel guard and the coverage router — no
 * model call, no new judge, nothing to sweet-talk.
 *
 * HOW: both frames are reduced to Sobel edge maps at a small fixed size.
 * A twilight relight changes tone everywhere but structure edges — rooflines,
 * window frames, driveway seams — stay where they are. The score is the best
 * edge-overlap over a small window of translations (a couple of resize pixels
 * of drift is optical noise, not a moved camera). An honest relight scores
 * high; a re-imagined frame's edges land somewhere else and cannot line up at
 * any small shift.
 *
 * TUNED, NOT GUESSED: the threshold was set against Kyle's 21 graded pairs
 * (2 Sep 2026) — his four framing fails and his framing-held passes — and the
 * golden cases c203–c211 carry that measurement forward. See FRAMELOCK_MIN.
 */
const sharp = require('sharp');

const W = 160, H = 120;
// Shifts tried in each axis. ±5 at 160px ≈ 3% drift — resize jitter, not a
// camera move.
const MAX_SHIFT = 5;
// Fraction of pixels kept as "edges" (strongest gradients).
const EDGE_FRAC = 0.12;

async function edgeMap(buf) {
  const { data } = await sharp(buf)
    .greyscale()
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Sobel magnitudes.
  const mag = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -data[i - W - 1] - 2 * data[i - 1] - data[i + W - 1]
               + data[i - W + 1] + 2 * data[i + 1] + data[i + W + 1];
      const gy = -data[i - W - 1] - 2 * data[i - W] - data[i - W + 1]
               + data[i + W - 1] + 2 * data[i + W] + data[i + W + 1];
      mag[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  // Threshold at the (1 - EDGE_FRAC) quantile → binary edge set.
  const sorted = Float32Array.from(mag).sort();
  const cut = sorted[Math.floor(sorted.length * (1 - EDGE_FRAC))] || 1;
  const edges = new Uint8Array(W * H);
  let count = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] >= cut && mag[i] > 0) { edges[i] = 1; count++; }
  return { edges, count };
}

function overlapAt(a, b, dx, dy) {
  let hit = 0;
  const y0 = Math.max(1, 1 - dy), y1 = Math.min(H - 1, H - 1 - dy);
  const x0 = Math.max(1, 1 - dx), x1 = Math.min(W - 1, W - 1 - dx);
  for (let y = y0; y < y1; y++) {
    const rowA = y * W, rowB = (y + dy) * W + dx;
    for (let x = x0; x < x1; x++) {
      if (a[rowA + x] && b[rowB + x]) hit++;
    }
  }
  return hit;
}

/**
 * Score two frames 0..1: the best edge-overlap over small shifts, normalised
 * by the smaller edge count. Same camera → high; re-imagined frame → low.
 */
async function frameScore(origBuf, candBuf) {
  const [A, B] = await Promise.all([edgeMap(origBuf), edgeMap(candBuf)]);
  const denom = Math.min(A.count, B.count) || 1;
  let best = 0, bestShift = [0, 0];
  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
      const s = overlapAt(A.edges, B.edges, dx, dy) / denom;
      if (s > best) { best = s; bestShift = [dx, dy]; }
    }
  }
  return { score: +best.toFixed(3), shift: bestShift };
}

/**
 * The gate. Below FRAMELOCK_MIN the candidate is a different photograph of
 * the property and dies deterministically, whatever any judge thinks.
 * Set FRAMELOCK_MIN=0 to disable.
 */
/**
 * Measured on Kyle's 21 graded pairs, 2 Sep 2026: every re-imagined frame he
 * failed scored 0.193–0.325; every framing-held pass scored 0.530–0.805.
 * 0.42 sits in the gap with ~0.1 of margin on each side. His non-framing
 * fails (invented lights, 0.608) score high — correctly someone else's job.
 */
const FRAMELOCK_MIN = parseFloat(process.env.FRAMELOCK_MIN || '0.42');

async function frameLock(origBuf, candBuf) {
  const { score, shift } = await frameScore(origBuf, candBuf);
  return { score, shift, ok: FRAMELOCK_MIN <= 0 || score >= FRAMELOCK_MIN, min: FRAMELOCK_MIN };
}

module.exports = { frameScore, frameLock, FRAMELOCK_MIN };
