/**
 * Listing Lab — the twilight look (Kyle, 10 Sep 2026).
 *
 * Every delivered Twilight gets one fixed tone adjustment before it is
 * stamped: exposure down a quarter stop and a gentle contrast S-curve. Kyle
 * chose it by eye from a four-way comparison on three real twilights. It is
 * plain pixel arithmetic — instant, free, identical every time — and it runs
 * AFTER every check has passed and immediately BEFORE the disclosure stamp,
 * so the inspector keeps judging the raw render and the stamp lands on the
 * final look. The clean copy kept for chained edits is the toned frame too.
 *
 * The maths, per channel value v in 0–255, exactly as the reference that
 * produced the comparison (NumPy, in TWILIGHT-LOOK.md §7):
 *   1. exposure in linear light:  x = (v/255)^2.2 · 2^ev, clamped to 0–1
 *   2. back to sRGB:              s = x^(1/2.2)
 *   3. the S-curve on s:          y = s + contrast · (s − 0.5) · (1 − |2s − 1|), clamped
 *   4. v' = round(y · 255)
 * The maths is per value, so a 256-entry table is exact and the frame is
 * one pass over the pixels.
 */
const sharp = require('sharp');
const { DELIVERY_JPEG_QUALITY } = require('./watermark');

const DEFAULT_EV = -0.25;
const DEFAULT_CONTRAST = 0.35;

/** The reference maths for one channel value. */
function toneValue(v, ev, contrast) {
  let x = Math.pow(v / 255, 2.2) * Math.pow(2, ev);
  x = Math.min(1, Math.max(0, x));
  const s = Math.pow(x, 1 / 2.2);
  let y = s + contrast * (s - 0.5) * (1 - Math.abs(2 * s - 1));
  y = Math.min(1, Math.max(0, y));
  return Math.round(y * 255);
}

/** All 256 values at once — computed once per call, applied per pixel. */
function toneTable(ev, contrast) {
  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v++) table[v] = toneValue(v, ev, contrast);
  return table;
}

/**
 * The look on a JPEG. `ev = 0` with `contrast = 0` is an exact no-op: the
 * same buffer comes back, not a re-encoded copy. Otherwise the frame is
 * re-encoded at the delivery quality the stamp uses.
 */
async function twilightLook(jpegBuffer, { ev = DEFAULT_EV, contrast = DEFAULT_CONTRAST } = {}) {
  if (ev === 0 && contrast === 0) return jpegBuffer;
  const table = toneTable(ev, contrast);
  const { data, info } = await sharp(jpegBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i++) data[i] = table[data[i]];
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .jpeg({ quality: DELIVERY_JPEG_QUALITY })
    .toBuffer();
}

/** The guard: only Twilight gets the look; every other type passes through untouched. */
async function lookForType(type, jpegBuffer, opts) {
  if (type !== 'twilight') return jpegBuffer;
  return twilightLook(jpegBuffer, opts);
}

module.exports = { twilightLook, lookForType, toneValue, toneTable, DEFAULT_EV, DEFAULT_CONTRAST };
