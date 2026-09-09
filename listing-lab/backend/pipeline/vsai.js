/**
 * Listing Lab — Virtual Staging AI (Zillow) as a candidate source.
 *
 * VSAI takes a photo + room type + style and returns finished renders. It cannot
 * run our stager brief, seeded draw, layout zones or client notes, so it is used
 * as a candidate source inside a staging round (STAGING_SOURCES in transform.js).
 * Everything downstream — compliance judge, camera/structure checks, ranking,
 * watermark, golden set — treats its output exactly like a Nano Banana candidate.
 *
 * Docs: https://docs.virtualstagingai.app/v2-api/endpoints.md
 * Key:  app Settings (issued on the Enterprise plan)      Env: VSAI_API_KEY
 * Billing: one "photo" per render REQUEST regardless of variation_count (up to 20);
 *          Enterprise $79/mo = 150 photos ≈ $0.53 per input photo. Overage unpublished.
 * Output URLs are signed and expire (~2 weeks) — we download immediately.
 */
const BASE = 'https://api.virtualstagingai.app/v2';

// Listing Lab → VSAI enums (exact strings from the v2 docs)
const ROOM_MAP = {
  'Living Room': 'living', 'Dining Room': 'dining', 'Primary Bedroom': 'bed',
  'Guest Bedroom': 'bed', 'Nursery / Kids Room': 'kids_room', 'Home Office': 'home_office',
  'Basement / Rec Room': 'living', 'Other': 'living',
};
// VSAI has no contemporary; nearest neighbour. Our Standard maps to their 'standard'.
const STYLE_MAP = { Modern: 'modern', Standard: 'standard', Contemporary: 'modern', Coastal: 'coastal', Luxury: 'luxury' };
const TWILIGHT_MAP = { 'Golden Hour': 'golden', 'Dusk': 'dusk', 'Blue Hour': 'blue' };

async function api(method, path, apiKey, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${apiKey}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`VSAI ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll a render until every variation is done/error. */
async function waitForRender(apiKey, renderId, { timeoutMs = 240000, intervalMs = 4000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await api('GET', `/renders/${renderId}?include_variations=true&variations_limit=20`, apiKey);
    const items = r.variations?.items || [];
    if (items.length && items.every(v => ['done', 'error', 'deleted'].includes(v.status))) return r;
    await sleep(intervalMs);
  }
  throw new Error('VSAI: render timed out');
}

async function download(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(`VSAI image fetch ${r.status}`);
  return { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mime_type: r.headers.get('content-type') || 'image/jpeg' };
}

/**
 * Stage a room. `imageRef` = public HTTPS URL or data: URL (both accepted).
 * Returns [{data, mime_type, url, source:'vsai', variationId, renderId}] — one per variation.
 * Our own disclosure watermark is applied downstream, so VSAI's is OFF.
 */
async function vsaiStage(apiKey, imageRef, roomType, style, opts = {}) {
  // Regenerations are unlimited on the plan: if a render already exists for this photo
  // (opts.renderId), add variations to it instead of creating a new render (= no new photo charged).
  if (opts.renderId) {
    const cfg = { type: 'staging', add_furniture: { room_type: ROOM_MAP[roomType] || 'living', style: STYLE_MAP[style] || 'standard' }, remove_furniture: { mode: opts.declutter || 'off' }, add_virtually_staged_watermark: false, output_resolution: 'default' };
    const before = new Set(((await api('GET', `/renders/${opts.renderId}?include_variations=true&variations_limit=20`, apiKey)).variations?.items || []).map(v => v.id));
    await api('POST', `/renders/${opts.renderId}/variations`, apiKey, { config: cfg, variation_count: Math.min(20, Math.max(1, opts.variations || 1)), wait_for_completion: false });
    const done = await waitForRender(apiKey, opts.renderId);
    const out = [];
    for (const v of done.variations.items) { if (before.has(v.id) || v.status !== 'done' || !v.result?.url) continue; out.push({ ...(await download(v.result.url)), url: v.result.url, source: 'vsai', renderId: opts.renderId, variationId: v.id, photosCharged: 0 }); }
    if (!out.length) throw new Error('VSAI: no new variations completed');
    return out;
  }
  const body = {
    config: {
      type: 'staging',
      add_furniture: { room_type: ROOM_MAP[roomType] || 'living', style: STYLE_MAP[style] || 'standard' },
      remove_furniture: { mode: opts.declutter || 'off' },
      add_virtually_staged_watermark: false,
      output_resolution: 'default', // default ≥1536px, up to 3072px long edge
    },
    image_url: imageRef,
    variation_count: Math.min(20, Math.max(1, opts.variations || 1)),
    wait_for_completion: false,
  };
  const created = await api('POST', '/renders', apiKey, body);
  const done = await waitForRender(apiKey, created.id);
  const out = [];
  for (const v of done.variations.items) {
    if (v.status !== 'done' || !v.result?.url) continue;
    const img = await download(v.result.url);
    out.push({ ...img, url: v.result.url, source: 'vsai', renderId: created.id, variationId: v.id, photosCharged: 1 / body.variation_count });
  }
  if (!out.length) throw new Error('VSAI: no completed variations');
  return out;
}

/** Day-to-dusk: sky_style dusk | golden | blue. */
async function vsaiTwilight(apiKey, imageRef, mood, opts = {}) {
  const created = await api('POST', '/renders', apiKey, {
    config: { type: 'daytodusk', sky_style: TWILIGHT_MAP[mood] || 'dusk' },
    image_url: imageRef, variation_count: Math.min(20, Math.max(1, opts.variations || 1)), wait_for_completion: false,
  });
  const done = await waitForRender(apiKey, created.id);
  const out = [];
  for (const v of done.variations.items) { if (v.status === 'done' && v.result?.url) out.push({ ...(await download(v.result.url)), url: v.result.url, source: 'vsai', renderId: created.id, variationId: v.id }); }
  if (!out.length) throw new Error('VSAI: no completed variations');
  return out;
}

/** Furniture removal only (declutter) — staging type with remove on and no add_furniture. */
async function vsaiDeclutter(apiKey, imageRef, maskUrl) {
  const created = await api('POST', '/renders', apiKey, {
    config: { type: 'staging', remove_furniture: { mode: 'on', ...(maskUrl ? { mask_url: maskUrl } : {}) }, add_virtually_staged_watermark: false, output_resolution: 'default' },
    image_url: imageRef, variation_count: 1, wait_for_completion: false,
  });
  const done = await waitForRender(apiKey, created.id);
  const v = done.variations.items.find(x => x.status === 'done' && x.result?.url);
  if (!v) throw new Error('VSAI: removal failed');
  return { ...(await download(v.result.url)), url: v.result.url, source: 'vsai', renderId: created.id, variationId: v.id };
}

/** Account check without spending: photo limits and usage this period. */
async function vsaiAccount(apiKey) {
  const status = await fetch(BASE + '/status').then(r => r.status).catch(e => e.message);
  const user = await api('GET', '/user', apiKey);
  return { apiStatus: status, user };
}

module.exports = { vsaiStage, vsaiTwilight, vsaiDeclutter, vsaiAccount, ROOM_MAP, STYLE_MAP, TWILIGHT_MAP };
