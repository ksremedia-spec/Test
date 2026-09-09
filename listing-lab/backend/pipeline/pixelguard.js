/**
 * PIXEL GUARD (1 Sep 2026, bench-gated: PIXEL_GUARD=1).
 *
 * The generative model REDRAWS the whole photograph, and the judges catch its
 * mistakes on fixed features — an altered brick wall, a vanished shelf, a
 * changed door — at a cost of two to four minutes per failed round. This
 * module makes those mistakes impossible instead of catchable: inside every
 * catalogued fixed-feature box, pixels the model left essentially unchanged
 * are SNAPPED BACK to the original photograph's exact pixels, so the wall in
 * the delivery IS the wall from the camera.
 *
 * What it deliberately keeps from the candidate: anything meaningfully
 * different inside a feature box — the new sofa arm crossing the brick, the
 * shadow a floor lamp throws on the panelling. Those read as intended changes
 * (occlusions and light), and overwriting them would float the furniture off
 * the photograph. The boundary between snapped and kept is feathered so no
 * seam survives for the realism critic to find.
 *
 * Cost: raw-buffer arithmetic plus three small blurs — about a second at 2K.
 * The wins are minutes: structural rejections stop happening for guarded
 * features, and (later, once trusted) their element-by-element re-inspection
 * can be skipped outright, since a copied wall needs no judge.
 */

/** Tunables — env-overridable so the bench can sweep them. */
const SNAP_BELOW = parseInt(process.env.PIXEL_GUARD_SNAP_BELOW || '14', 10); // 0-255 diff under which a pixel snaps to the original
const BOX_PAD_PCT = parseFloat(process.env.PIXEL_GUARD_PAD_PCT || '1');      // widen each feature box slightly
const FEATHER = parseFloat(process.env.PIXEL_GUARD_FEATHER || '3');          // mask blur sigma, px
const ERODE = parseFloat(process.env.PIXEL_GUARD_ERODE || '5');              // neighborhood radius a snap must fully clear

/**
 * @param sharp the sharp module (injected, like drawNoGoReference)
 * @param originalBuf original photograph bytes
 * @param gen { data: base64, mime_type } — the colour-normalised candidate, already at the original's size
 * @param fixedElements [{ name, kind, x_from, x_to, y_from, y_to }] in percent of frame
 * @returns { data, mime_type, stats: { features, snappedPct, perFeature } }
 */
async function pixelGuard(sharp, originalBuf, gen, fixedElements) {
  const boxes = (fixedElements || []).filter(f =>
    Number.isFinite(f.x_from) && Number.isFinite(f.x_to) && Number.isFinite(f.y_from) && Number.isFinite(f.y_to)
    && f.x_to > f.x_from && f.y_to > f.y_from);
  if (!boxes.length) return { ...gen, stats: { features: 0, snappedPct: 0, perFeature: [] } };

  const { data: o, info } = await sharp(originalBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, CH = info.channels;
  const candidateBuf = Buffer.from(gen.data, 'base64');
  const { data: c, info: ci } = await sharp(candidateBuf).removeAlpha().resize(W, H, { fit: 'fill' }).raw()
    .toBuffer({ resolveWithObject: true });
  if (ci.channels !== CH) throw new Error(`channel mismatch: original ${CH} vs candidate ${ci.channels}`);

  // Per-pixel difference (max across channels), then a small blur so one noisy
  // pixel neither snaps nor survives alone.
  const diff = Buffer.alloc(W * H);
  for (let p = 0, q = 0; p < diff.length; p++, q += CH) {
    let d = Math.abs(o[q] - c[q]);
    const d1 = Math.abs(o[q + 1] - c[q + 1]); if (d1 > d) d = d1;
    const d2 = Math.abs(o[q + 2] - c[q + 2]); if (d2 > d) d = d2;
    diff[p] = d;
  }
  // sharp's blur pipeline promotes 1-channel raw to 3 channels on output
  // (measured 1 Sep 2026: 20000 bytes in, 60000 out) — read it with its own
  // stride or every index past the first row is garbage.
  const bd = await sharp(diff, { raw: { width: W, height: H, channels: 1 } }).blur(1.5).raw().toBuffer({ resolveWithObject: true });
  const blurredDiff = bd.data, bdStride = bd.info.channels;

  // The snap mask: 255 where a pixel sits inside a (padded) feature box AND the
  // model left it essentially unchanged. Everything else 0.
  const mask = Buffer.alloc(W * H);
  const perFeature = [];
  for (const f of boxes) {
    const x0 = Math.max(0, Math.floor(((f.x_from - BOX_PAD_PCT) / 100) * W));
    const x1 = Math.min(W, Math.ceil(((f.x_to + BOX_PAD_PCT) / 100) * W));
    const y0 = Math.max(0, Math.floor(((f.y_from - BOX_PAD_PCT) / 100) * H));
    const y1 = Math.min(H, Math.ceil(((f.y_to + BOX_PAD_PCT) / 100) * H));
    let inBox = 0, snapped = 0;
    for (let y = y0; y < y1; y++) {
      const row = y * W;
      for (let x = x0; x < x1; x++) {
        inBox++;
        if (blurredDiff[(row + x) * bdStride] < SNAP_BELOW) { mask[row + x] = 255; snapped++; }
      }
    }
    perFeature.push({ name: f.name, kind: f.kind, snappedPctOfBox: inBox ? Math.round(100 * snapped / inBox) : 0 });
  }

  /**
   * EROSION — the anti-ghosting rule (1 Sep 2026, found by Kyle's own test
   * demand). Dark furniture in front of a dark door matches the original
   * almost pixel-for-pixel in places, and per-pixel snapping painted door
   * over sofa — brown blotches bleeding through the cushions. The asymmetry
   * decides the fix: a false SNAP is a visible artifact, a false KEEP costs
   * nothing (the AI's own wall stays). So a pixel may snap only when its
   * ENTIRE neighborhood is unchanged — isolated low-diff islands inside
   * furniture die here. Blur-then-threshold approximates erosion: only
   * pixels whose surroundings are almost all snap-eligible survive.
   */
  const er = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).blur(ERODE).raw().toBuffer({ resolveWithObject: true });
  const eroded = Buffer.alloc(W * H);
  for (let p2 = 0; p2 < W * H; p2++) eroded[p2] = er.data[p2 * er.info.channels] >= 248 ? 255 : 0;

  // Feather the eroded boundary so snapped-original and kept-candidate melt together.
  const fe = await sharp(eroded, { raw: { width: W, height: H, channels: 1 } }).blur(FEATHER).raw().toBuffer({ resolveWithObject: true });
  const feathered = fe.data, feStride = fe.info.channels;

  // out = original*m + candidate*(1-m)
  const out = Buffer.alloc(W * H * CH);
  let snappedTotal = 0;
  for (let p = 0, q = 0; p < W * H; p++, q += CH) {
    const m = feathered[p * feStride];
    if (m === 0) { out[q] = c[q]; out[q + 1] = c[q + 1]; out[q + 2] = c[q + 2]; continue; }
    if (m === 255) { out[q] = o[q]; out[q + 1] = o[q + 1]; out[q + 2] = o[q + 2]; snappedTotal++; continue; }
    const n = 255 - m;
    out[q] = (o[q] * m + c[q] * n + 127) >> 8;
    out[q + 1] = (o[q + 1] * m + c[q + 1] * n + 127) >> 8;
    out[q + 2] = (o[q + 2] * m + c[q + 2] * n + 127) >> 8;
  }

  const jpeg = await sharp(out, { raw: { width: W, height: H, channels: CH } }).jpeg({ quality: 92 }).toBuffer();
  return {
    data: jpeg.toString('base64'),
    mime_type: 'image/jpeg',
    stats: {
      features: boxes.length,
      snappedPct: Math.round(1000 * snappedTotal / (W * H)) / 10,
      perFeature,
    },
  };
}

module.exports = { pixelGuard, SNAP_BELOW };
