/**
 * Listing Lab — colour lock.
 *
 * WHY THIS EXISTS
 * Kyle, 26 Aug 2026, on a delivered bathroom declutter: "it slightly changed the
 * color of the photo". Measured on the parts of the frame nothing was removed
 * from — ceiling, left wall, window glass, tile floor — the delivered file was
 * red +5, blue +4, green +0 against his original. A uniform warm/magenta lift of
 * about 2%. Every compliance judge passed it, and they were never going to catch
 * it: the prompt tells them "exposure/white balance changed" is a violation, and
 * a 2% shift is invisible to a vision model looking at two images side by side.
 * A photographer sees it immediately.
 *
 * The cause is structural, not a bad prompt. The image model does not edit the
 * photograph; it re-renders the whole frame, so its own colour rendering lands on
 * every pixel including the ones it was told not to touch.
 *
 * WHAT THIS DOES
 * Measures the drift on the pixels that did NOT change (which is most of the
 * frame in a declutter, and still most of it in an empty), fits one gain and one
 * offset per channel, and applies that correction to the whole frame. This does
 * not "improve" the photo and it is not a look: it pulls the model's rendering
 * back onto the photographer's own, which is the only colour this product has any
 * business delivering.
 *
 * Guardrails, because a correction that fires on the wrong thing is worse than no
 * correction: the fit is refused if it wants more than a small nudge (something
 * bigger than a tint happened — a light switched on, the room relit) and refused
 * if too little of the frame is unchanged to measure against. In both cases the
 * caller is told, and the image goes through untouched for the judges to rule on.
 *
 * Twilight never comes here. Relighting the scene IS the job there.
 */
const sharp = require('sharp');

// A 4K render is ~50 megapixels once decoded. sharp's default cache holds
// decoded frames in memory for reuse, which is the wrong trade in a container
// that handles one job at a time and was seen dying on the third large frame.
sharp.cache(false);

/** Where the fit is measured. Small is fine — this is a global average. */
const SAMPLE_W = 512;
const SAMPLE_H = 340;

/**
 * Beyond these, the difference is not a rendering drift and must not be silently
 * corrected away. A gain of 1.06 is a 6% channel shift; real drift is 1–3%.
 */
const MAX_GAIN = parseFloat(process.env.COLOUR_MAX_GAIN || '1.12');
const MIN_GAIN = parseFloat(process.env.COLOUR_MIN_GAIN || '0.89');
const MAX_OFFSET = parseFloat(process.env.COLOUR_MAX_OFFSET || '14');

/**
 * WHY THESE ARE OVERRIDABLE, AND WHY THE DEFAULTS DO NOT MOVE.
 *
 * The numbers above were fitted to gemini-3-pro-image, whose drift really is
 * 1–3%. gemini-3.1-flash-image — the outage fallback — carries a slightly
 * stronger and UNEVEN cast (measured 27 Aug 2026: about -6 red, -4 green, -4
 * blue on a 0–255 scale), and half its empty-room frames were refused here and
 * failed the judge for exposure. Not a bad picture: a tinted one we declined to
 * fix.
 *
 * Widening is not free. The limits exist so a genuine relight — the model
 * deciding to brighten a dim room, which for declutter and empty is a
 * compliance failure — cannot be silently corrected into looking compliant.
 * Push them too far and the exposure check stops meaning anything, because we
 * will have erased the evidence before the judge sees it.
 *
 * So: env-tunable for experiment, defaults unchanged until someone has looked
 * at corrected frames and confirmed they read as the original lighting.
 */

/** Below this share of the frame reading as unchanged, there is nothing to fit to. */
const MIN_UNCHANGED_SHARE = 0.25;

/** What counts as "delivered clean" once corrected, per channel, 0–255. */
const RESIDUAL_TOLERANCE = 1.5;

/** Raw RGB at a fixed size, so two frames of slightly different shape align. */
async function sample(buf) {
  const { data } = await sharp(buf)
    .resize(SAMPLE_W, SAMPLE_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

/**
 * The pixels that did not change, as an index list into the sample.
 *
 * Objects that were removed differ enormously; untouched wall differs by a couple
 * of levels. Sorting by difference and keeping the calmest share separates the two
 * without needing to know what was removed or where.
 */
function unchangedPixels(a, b, share) {
  const n = a.length / 3;
  const diff = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    diff[i] = Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]);
  }
  const sorted = Float32Array.from(diff).sort();
  const cutoff = sorted[Math.floor(n * share)];
  const keep = [];
  for (let i = 0; i < n; i++) if (diff[i] <= cutoff) keep.push(i);
  return keep;
}

/** Least squares fit of original = gain * generated + offset, one channel. */
function fitChannel(orig, gen, idx, c) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const i of idx) {
    const x = gen[i * 3 + c], y = orig[i * 3 + c];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = idx.length;
  const denom = n * sxx - sx * sx;
  // A dead-flat region (a blown-out white wall and nothing else) has no slope to
  // fit. Fall back to offset-only rather than dividing by ~0 and inventing a gain.
  if (Math.abs(denom) < 1e-6) return { gain: 1, offset: (sy - sx) / n };
  const gain = (n * sxy - sx * sy) / denom;
  return { gain, offset: (sy - gain * sx) / n };
}

/** Mean signed difference per channel over the given pixels: original − generated. */
function drift(orig, gen, idx) {
  const d = [0, 0, 0];
  for (const i of idx) for (let c = 0; c < 3; c++) d[c] += orig[i * 3 + c] - gen[i * 3 + c];
  return d.map(v => v / idx.length);
}

/**
 * Pull `generatedBuf` back onto `originalBuf`'s colour rendering.
 *
 * Returns the buffer to use downstream — corrected if the fit was sane, the
 * original generated bytes if not — plus everything measured, for the audit.
 */
async function lockColour(originalBuf, generatedBuf, opts = {}) {
  const share = opts.share ?? 0.6;
  // Limits are per-call so a single process can hold pro-image to a tight drift
  // and give the flash fallback the wider one its uneven cast needs, without
  // either affecting the other. Default to the module constants (pro's numbers).
  const maxGain = opts.maxGain ?? MAX_GAIN;
  const minGain = opts.minGain ?? MIN_GAIN;
  const maxOffset = opts.maxOffset ?? MAX_OFFSET;
  const report = { applied: false, reason: null, before: null, after: null, gains: null, offsets: null,
                   limits: { maxGain, minGain, maxOffset } };

  const [orig, gen] = await Promise.all([sample(originalBuf), sample(generatedBuf)]);
  const idx = unchangedPixels(orig, gen, share);
  report.unchangedShare = +(idx.length / (orig.length / 3)).toFixed(3);
  report.before = drift(orig, gen, idx).map(v => +v.toFixed(2));

  if (report.unchangedShare < MIN_UNCHANGED_SHARE) {
    report.reason = 'too little of the frame is unchanged to measure colour against';
    return { buf: generatedBuf, ...report };
  }

  const fits = [0, 1, 2].map(c => fitChannel(orig, gen, idx, c));
  report.gains = fits.map(f => +f.gain.toFixed(4));
  report.offsets = fits.map(f => +f.offset.toFixed(2));

  const outOfRange = fits.some(f =>
    !Number.isFinite(f.gain) || !Number.isFinite(f.offset) ||
    f.gain > maxGain || f.gain < minGain || Math.abs(f.offset) > maxOffset);
  if (outOfRange) {
    // Deliberately NOT corrected. A shift this size means the scene itself was
    // rendered differently — a light switched on, the room relit, the exposure
    // pushed — and that is a compliance question, not a tint to paper over.
    report.reason = 'the difference is larger than a rendering drift — left for the judges';
    return { buf: generatedBuf, ...report };
  }

  // Correction and resize happen in ONE pass on purpose. Done separately they
  // decode and re-encode a 50-megapixel frame twice, and the container was killed
  // mid-run doing exactly that (`pipeline exited null` — a signal, not an error).
  // Resizing first also means the correction runs over four times fewer pixels.
  let pipe = sharp(generatedBuf, { sequentialRead: true });
  if (opts.resizeTo) pipe = pipe.resize(opts.resizeTo[0], opts.resizeTo[1], { fit: 'fill', kernel: 'lanczos3' });
  const corrected = await pipe
    .linear(fits.map(f => f.gain), fits.map(f => f.offset))
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  // Measure the result rather than trusting the arithmetic: the fit happens on a
  // 512-wide sample and gets applied to a full-size frame through a JPEG encode.
  const after = drift(orig, await sample(corrected), idx).map(v => +v.toFixed(2));
  report.after = after;
  report.applied = true;
  report.within = after.every(v => Math.abs(v) <= RESIDUAL_TOLERANCE);
  if (!report.within) report.reason = 'corrected, but still outside tolerance';
  return { buf: corrected, ...report };
}

/**
 * Read-only measurement, for a check that wants to know without changing anything.
 * Same numbers `lockColour` reports as `before`.
 */
async function measureColourDrift(originalBuf, generatedBuf, share = 0.6) {
  const [orig, gen] = await Promise.all([sample(originalBuf), sample(generatedBuf)]);
  const idx = unchangedPixels(orig, gen, share);
  return {
    unchangedShare: +(idx.length / (orig.length / 3)).toFixed(3),
    drift: drift(orig, gen, idx).map(v => +v.toFixed(2)),
  };
}

/**
 * What size the delivered frame should be — DOWN to the original, never up.
 *
 * The model returns whatever size it feels like: a 4096px original came back
 * 5056px. That extra size is interpolation, not detail, so it goes.
 *
 * The other direction is the one that matters. Kyle, 26 Aug 2026: a luxury
 * listing is edited and delivered at around 56 megapixels. The image model tops
 * out near 17. Stretching a 5000px render up to 9000px to "match the original"
 * would manufacture a 3x of detail that was never photographed, and that is the
 * file that ends up in print. So when the original is bigger, the render is
 * delivered at its own honest size and the job says so.
 */
function sizeDecision(a, b) {
  if (!a?.width || !b?.width) return null;
  if (a.width === b.width && a.height === b.height) return null;
  const originalIsLarger = a.width * a.height > b.width * b.height;
  if (originalIsLarger) return null; // deliver what the model actually made
  return [a.width, a.height];
}

async function targetSize(originalBuf, buf) {
  const [a, b] = await Promise.all([sharp(originalBuf).metadata(), sharp(buf).metadata()]);
  return sizeDecision(a, b);
}

async function matchDimensions(originalBuf, buf) {
  const [a, b] = await Promise.all([sharp(originalBuf).metadata(), sharp(buf).metadata()]);
  const to = sizeDecision(a, b);
  if (!to) return { buf, resized: false, from: [b.width, b.height], to: [b.width, b.height] };
  const out = await sharp(buf)
    .resize(to[0], to[1], { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { buf: out, resized: true, from: [b.width, b.height], to };
}

/**
 * Which resolution to ask the model for, decided by the photograph in hand.
 *
 * Anything generated above the original's size is thrown away again on the way
 * out, so paying 4K prices for a 2048px upload buys nothing — the delivered file
 * is identical either way. 4K costs $0.24 a frame against $0.134 for 2K, and a
 * declutter clears about $1.30, so this is not the difference between a business
 * and no business; it is just money set on fire for no picture.
 *
 * The threshold sits above 2048 rather than on it: the model overshoots its own
 * label (a "4K" request came back 5056px), and a 2K request lands near 2048, so
 * a source a little over 2048 is still served honestly by 2K without upscaling.
 */
const TWO_K_MAX_EDGE = 2600;

function imageSizeFor(meta) {
  const edge = Math.max(meta?.width || 0, meta?.height || 0);
  if (!edge) return '4K';
  return edge <= TWO_K_MAX_EDGE ? '2K' : '4K';
}

module.exports = {
  lockColour, measureColourDrift, matchDimensions, targetSize, imageSizeFor, TWO_K_MAX_EDGE,
  MAX_GAIN, MIN_GAIN, MAX_OFFSET, MIN_UNCHANGED_SHARE, RESIDUAL_TOLERANCE,
};
