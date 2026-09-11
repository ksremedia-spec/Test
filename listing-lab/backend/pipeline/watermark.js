/**
 * Listing Lab — server-side disclosure mark.
 *
 * Applied AFTER compliance passes, BEFORE delivery. Not optional, not removable
 * by the customer.
 *
 * WHY IT LOOKS THE WAY IT DOES (redesigned 25 Aug 2026)
 * The first version was a filled dark pill with wide-tracked capitals. Kyle's
 * word for it was "hideous", and he was right — it read like a parking permit
 * stamped on a photograph he was proud of.
 *
 * A disclosure has one job: be readable by someone looking for it. It does not
 * need to dominate the frame, and a mark that makes an agent reluctant to use
 * the product defeats the product.
 *
 * So:
 *   - no box, no fill — type sits directly on the photograph
 *   - sentence case ("Virtually staged"), not SHOUTING CAPS
 *   - roughly half the old size
 *   - a soft dark shadow behind white type, which is what keeps it legible over
 *     a blown-out window AND over dark flooring without needing a slab
 *
 * TWILIGHT CARRIES NO MARK. Relighting a sky is not a material
 * misrepresentation — nothing that exists has been added, removed or hidden.
 * `WATERMARK_TEXT.twilight` is null and this is never called for it.
 */
const sharp = require('sharp');

/**
 * Geometry, shared by apply and verify so the two can never drift apart.
 * Sizes are a fraction of image width, so a 2K export and a 4K export get a mark
 * of the same visual weight.
 */
function markGeometry(W, H, text) {
  // 2.2% of width (30 Aug 2026, Kyle's pick from a rendered size ladder: option
  // G). The 25 Aug redesign halved the old slab to 0.62%, which turned out too
  // timid — in the field the mark all but vanished on phone screens, and a
  // disclosure nobody can find protects nobody. The styling (no box, sentence
  // case, soft shadow) is what made the old size hideous, and that stays.
  const fontSize = Math.max(13, Math.round(W * 0.022));
  const x = Math.round(W * 0.022);
  const y = Math.round(H * 0.028);
  // Generous box for the verification sample — the text sits inside it.
  const boxW = Math.round(text.length * fontSize * 0.62) + fontSize;
  const boxH = Math.round(fontSize * 1.9);
  return { fontSize, x, y, boxW, boxH };
}

function markSvg(W, H, text) {
  const g = markGeometry(W, H, text);
  const blur = Math.max(1, g.fontSize * 0.09);
  const dy = Math.max(1, Math.round(g.fontSize * 0.06));
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="s" x="-30%" y="-30%" width="160%" height="160%">
      <!-- Two shadows: a tight one for edge definition on light backgrounds, a
           wider soft one so the type still separates from a busy photograph. -->
      <feDropShadow dx="0" dy="${dy}" stdDeviation="${blur}" flood-color="#000" flood-opacity="0.55"/>
      <feDropShadow dx="0" dy="0" stdDeviation="${(blur * 2.4).toFixed(2)}" flood-color="#000" flood-opacity="0.32"/>
    </filter>
  </defs>
  <text x="${g.x}" y="${g.y + g.fontSize}"
        font-family="Liberation Sans, Helvetica, Arial, sans-serif"
        font-size="${g.fontSize}" font-weight="500"
        letter-spacing="${(g.fontSize * 0.02).toFixed(2)}"
        fill="#FFFFFF" fill-opacity="0.92" filter="url(#s)">${escapeXml(text)}</text>
</svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/** The JPEG quality of every delivered frame — the stamp's encode, and the twilight look's. */
const DELIVERY_JPEG_QUALITY = 92;

async function applyWatermark(inputBuffer, text) {
  const img = sharp(inputBuffer);
  const meta = await img.metadata();
  const W = meta.width, H = meta.height;
  return img
    .composite([{ input: Buffer.from(markSvg(W, H, text)), top: 0, left: 0 }])
    .jpeg({ quality: DELIVERY_JPEG_QUALITY })
    .toBuffer();
}

/**
 * Confirm the mark actually landed.
 *
 * The old check measured whether the mark region was DARK, which only worked
 * because the mark was a dark slab. With type-on-photo there is no reliable
 * luminance signature — over a dark floor a correct mark is bright, over a
 * window it is dark.
 *
 * So the check is a measurement instead of a guess. `glyphsRendered` renders the
 * mark on its own transparent canvas and measures how much of the box is
 * actually ink. That is what catches the failure that shipped on 25 Aug 2026,
 * where the container had no fonts and every glyph came out as an empty
 * rectangle: hollow boxes ink far less area than real letters.
 *
 * When the pre-watermark image is supplied, it also confirms the composite
 * genuinely changed those pixels.
 */
async function verifyWatermark(watermarkedBuffer, text, originalBuffer = null) {
  const meta = await sharp(watermarkedBuffer).metadata();
  const W = meta.width, H = meta.height;
  const g = markGeometry(W, H, text);
  const pad = Math.round(g.fontSize * 0.4);
  const box = {
    left: Math.max(0, g.x - pad),
    top: Math.max(0, g.y - pad),
    width: Math.min(W - Math.max(0, g.x - pad), g.boxW),
    height: Math.min(H - Math.max(0, g.y - pad), g.boxH),
  };

  // The SVG already renders on transparency, so read it directly rather than
  // compositing it onto a blank canvas first — fewer moving parts, and sharp
  // reorders extract around composite in ways that are easy to get wrong.
  const alone = await sharp(Buffer.from(markSvg(W, H, text)))
    .extract(box).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let inked = 0;
  for (let i = 3; i < alone.data.length; i += 4) if (alone.data[i] > 40) inked++;
  const glyphsRendered = inked / (box.width * box.height);

  let changedFraction = null;
  if (originalBuffer) {
    const [a, b] = await Promise.all([
      sharp(originalBuffer).extract(box).greyscale().raw().toBuffer(),
      sharp(watermarkedBuffer).extract(box).greyscale().raw().toBuffer(),
    ]);
    let changed = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > 8) changed++;
    changedFraction = changed / n;
  }

  // Deliberately loose. This asks "did anything happen at all", not "is it
  // pretty" — its job is to catch a mark that never applied, or one made of
  // empty boxes.
  const present = glyphsRendered > 0.012 && (changedFraction === null || changedFraction > 0.008);
  return {
    present,
    glyphsRendered: +(glyphsRendered * 100).toFixed(2),
    changedPercent: changedFraction === null ? null : +(changedFraction * 100).toFixed(2),
  };
}

module.exports = { applyWatermark, verifyWatermark, markGeometry, markSvg, DELIVERY_JPEG_QUALITY };
