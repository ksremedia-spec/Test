/**
 * Listing Lab — upright input.
 *
 * WHY (the first outside tester, 3 Sep 2026 evening). An iPhone shoots a
 * portrait photo, stores the pixels SIDEWAYS, and writes an EXIF tag saying
 * "rotate me 90°". Phones and browsers honour the tag, so the agent sees an
 * upright room. The pipeline fed the raw sideways pixels to the model and the
 * judge, and handed back a sideways frame with no tag — the customer's
 * original stood upright beside a result lying on its side, and the model,
 * asked to declutter a closet rotated 90°, did nothing useful with it.
 *
 * Every input is turned upright here, once, before any pixel is read by
 * anything else. Photos with no tag (or tag 1) pass through untouched — the
 * bytes are identical, so nothing downstream changes for the 95% of uploads
 * that were fine already.
 */
const sharp = require('sharp');

/**
 * Returns { buf, oriented, orientation }. `buf` is the input unchanged when
 * no rotation was needed; otherwise a re-encoded upright image in the same
 * format (JPEG quality 95, PNG lossless), with the orientation tag gone.
 */
async function uprightInput(buf) {
  const meta = await sharp(buf).metadata();
  const orientation = meta.orientation || 1;
  if (orientation === 1) return { buf, oriented: false, orientation };
  let pipe = sharp(buf).rotate();   // no argument: rotate by the EXIF tag
  pipe = meta.format === 'png' ? pipe.png() : pipe.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
  const out = await pipe.toBuffer();
  return { buf: out, oriented: true, orientation };
}

module.exports = { uprightInput };
