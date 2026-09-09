/**
 * Listing Lab — the same image model, reached through Vertex AI.
 *
 * WHY A SECOND WAY IN
 * Today every generation goes: container → our Worker → Google's developer API.
 * The Worker is in the middle only because Google refuses the container's egress
 * by location (Round 27), and that hop carries a hard ceiling — Cloudflare cuts a
 * Worker's outbound fetch at 125 seconds and returns a synthesised 524, measured
 * 26 Aug 2026 at 125.037s. Any generation Google takes longer than two minutes to
 * produce dies there no matter how healthy it is at the far end.
 *
 * Vertex is the same model behind Google Cloud's front door: a project, its own
 * credentials, regional endpoints. A container can call it directly, so the
 * Worker leaves the path and the ceiling goes with it.
 *
 * WHAT IS DIFFERENT, AND WHY THIS FILE EXISTS AT ALL
 * The wire format is not the same. The developer API takes `input` and
 * `response_format` and answers with `steps[].content[]`; Vertex takes `contents`
 * and `generationConfig.responseModalities` and answers with
 * `candidates[].content.parts[].inlineData`. Same model, different envelope. So
 * the swap is not a URL change, which is exactly why it gets its own adapter with
 * its own tests rather than an `if` in the middle of gemini.js.
 *
 * NOTHING HERE IS LIVE UNTIL A REAL CALL PROVES IT. The shape below is built from
 * Google's REST documentation; the pipeline keeps using the developer API until
 * PROVIDER=vertex is set deliberately.
 */
const crypto = require('crypto');
const { msLeft } = require('./gemini');
const meter = require('./meter.js');

/**
 * The same hard timeout the developer-API path has, for the same reason: a
 * socket that never answers stalls the whole job, and fetch has no default. The
 * job's deadline wins whenever it is nearer — Vertex is reached as a fallback
 * from an already-failing generation, so it starts with less time in hand than
 * a first attempt does and must not be given a fresh three minutes.
 */
// Two minutes, matching gemini.js — see the reasoning there. A healthy 2K
// generation is 27–37 seconds; the old three-minute allowance only ever bought
// the right to keep holding a socket that had already failed.
const TIMEOUT_MS = parseInt(process.env.VERTEX_TIMEOUT_MS || '120000', 10);

/**
 * Retry, because this door is now the FIRST one and it has a rate limit.
 *
 * When this file was written Vertex was a migration target nobody had called in
 * anger, and a single fetch was honest about that. It is now the primary path
 * for every generation, and express mode caps requests per minute — four
 * concurrent jobs tripped it on 26 Aug 2026 and every one of them failed, while
 * the identical request from the identical key answered 200 a minute later.
 *
 * A 429 here is OUR rate limit, not Google's capacity, and it is the most
 * recoverable failure in the system: wait, and it goes away. Not retrying it was
 * the difference between a job that delivers and a job that parks for ninety
 * seconds over something that fixes itself in thirty.
 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;

/**
 * Where Vertex lives. Read at call time, not at import: the container is handed
 * its configuration by the platform, and a value frozen when the module loaded is
 * a value that ignores whatever was set afterwards.
 */
const region = () => process.env.VERTEX_REGION || 'us-east4';
const project = () => process.env.VERTEX_PROJECT || '';
const model = () => process.env.VERTEX_IMAGE_MODEL || 'gemini-3-pro-image';

/**
 * Two ways to authenticate, and the simpler one is worth trying first.
 *
 *   VERTEX_API_KEY — express mode. One key, no key file, no token exchange.
 *   VERTEX_SA_JSON — a service account. The production shape: sign a JWT with the
 *                    private key, swap it for an access token, refresh on expiry.
 *
 * Express mode is the cheap way to answer "does this work from the container at
 * all"; the service account is what a real deployment should end up on, because
 * it can be scoped and rotated on its own instead of being one key for everything
 * (which is how a single console click took the whole pipeline down on 25 Aug).
 */
function authMode() {
  if (process.env.VERTEX_API_KEY) return 'api_key';
  if (process.env.VERTEX_SA_JSON) return 'service_account';
  return null;
}

/** base64url, because JWTs are not base64 and the difference is three characters. */
const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let cachedToken = null; // { token, expiresAt }

/**
 * A Google access token from a service account, without the gcloud CLI — the
 * container has no gcloud and should not grow one. Signed JWT in, token out.
 * Cached until a minute before expiry, because minting one per generation would
 * add a round trip to every call for no reason.
 */
async function accessToken(now = Date.now(), fetchImpl = fetch) {
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;
  const sa = JSON.parse(process.env.VERTEX_SA_JSON);
  if (!sa.client_email || !sa.private_key) throw new Error('VERTEX_SA_JSON is missing client_email or private_key');

  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
    iat, exp: iat + 3600,
  }));
  const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), sa.private_key));

  const res = await fetchImpl(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vertex auth ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  cachedToken = { token: body.access_token, expiresAt: now + (body.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

/** Forget any cached token. Tests, and a credential rotation, both need this. */
function resetAuth() { cachedToken = null; }

/**
 * The URL to POST to, which differs by how we authenticate: express mode talks to
 * the global publisher endpoint, a service account to the project's own region.
 */
function endpoint(mode = authMode()) {
  if (mode === 'api_key') {
    return `https://aiplatform.googleapis.com/v1/publishers/google/models/${model()}:generateContent`;
  }
  if (!project()) throw new Error('VERTEX_PROJECT must be set to call Vertex with a service account');
  return `https://${region()}-aiplatform.googleapis.com/v1/projects/${project()}` +
         `/locations/${region()}/publishers/google/models/${model()}:generateContent`;
}

/**
 * Vertex's request body for an edit: the instruction and the photograph in
 * `contents`, and an explicit ask for an image back. `imageSize` is how 1K/2K/4K
 * is requested here — the developer API spells the same thing `response_format`.
 */
function buildBody(prompt, imageB64, imageMime, opts = {}) {
  const parts = [{ text: prompt }];
  for (const r of opts.references || []) {
    parts.push({ text: r.label });
    parts.push({ inlineData: { mimeType: r.mime_type || 'image/jpeg', data: r.data } });
  }
  if (opts.references && opts.references.length) {
    parts.push({ text: 'NOW THE PHOTO TO EDIT (output this one, transformed):' });
  }
  parts.push({ inlineData: { mimeType: imageMime, data: imageB64 } });
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { imageSize: opts.imageSize || '2K' },
    },
  };
}

/**
 * Pull the picture out of Vertex's reply.
 *
 * Deliberately strict: an answer with no image is an error, never an empty
 * success. The developer-API path learned this the hard way — a response the
 * client could not read was reported as "No image in response" three times and
 * cost three real generations before anyone knew why.
 */
function imageFromResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => (p.inlineData || p.inline_data)?.data);
  if (!img) {
    const text = parts.map(p => p.text).filter(Boolean).join(' ').slice(0, 200);
    throw new Error('No image in Vertex response' + (text ? `: ${text}` : `: ${JSON.stringify(json).slice(0, 200)}`));
  }
  const inline = img.inlineData || img.inline_data;
  return { data: inline.data, mime_type: inline.mimeType || inline.mime_type || 'image/jpeg' };
}

/**
 * Same signature as `nanoBananaEdit` in gemini.js, on purpose: the orchestrator
 * should not know or care which provider produced the frame.
 */
async function vertexEdit(_unusedKey, prompt, imageB64, imageMime, opts = {}, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const mode = deps.mode || authMode();
  if (!mode) throw new Error('Vertex is not configured: set VERTEX_API_KEY or VERTEX_SA_JSON');

  const headers = { 'content-type': 'application/json' };
  let url = deps.endpoint || endpoint(mode);
  if (mode === 'api_key') headers['x-goog-api-key'] = process.env.VERTEX_API_KEY;
  else headers.authorization = `Bearer ${await accessToken(deps.now || Date.now(), fetchImpl)}`;

  const body = JSON.stringify(buildBody(prompt, imageB64, imageMime, opts));
  const retries = opts.retries === undefined ? MAX_RETRIES : opts.retries;
  let lastErr;

  for (let i = 0; i <= retries; i++) {
    // Never start a call the job has no time left to receive the answer to.
    const budget = Math.min(TIMEOUT_MS, msLeft());
    if (budget <= 0) throw lastErr || new Error('Vertex call abandoned: the job ran out of time');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budget);
    let res, text;
    let callT0 = Date.now();
    try {
      callT0 = Date.now();
      res = await fetchImpl(url, { method: 'POST', headers, signal: ac.signal, body });
      text = await res.text();
    } catch (e) {
      lastErr = e.name === 'AbortError'
        ? new Error(`Vertex request timed out after ${(budget / 1000).toFixed(0)}s`)
        : e;
      if (e.name !== 'AbortError') throw lastErr;
      res = null;
    } finally {
      clearTimeout(timer);
    }

    let vUsage = null;
    try { vUsage = JSON.parse(text).usageMetadata || null; } catch {}
    meter.note({ kind: 'image', model: model(), door: 'vertex', ms: Date.now() - callT0,
                 ok: !!(res && res.ok), status: res ? res.status : null, attempt: i + 1,
                 promptTokens: vUsage?.promptTokenCount ?? null, outputTokens: vUsage?.candidatesTokenCount ?? null });
    if (res && res.ok) return imageFromResponse(JSON.parse(text));
    if (res) {
      lastErr = new Error(`Vertex ${res.status}: ${text.slice(0, 300)}`);
      if (!RETRY_STATUS.has(res.status)) throw lastErr;
    }

    if (i < retries) {
      const wait = Math.min(30000, 1500 * 2 ** i) + Math.floor(Math.random() * 500);
      // Sleeping past the deadline helps nobody: the retry it is waiting for
      // would be refused on arrival.
      if (wait + 5000 > msLeft()) break;
      console.error(`  Vertex transient error (${lastErr.message.slice(0, 60)}…) — retrying in ${(wait / 1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = {
  vertexEdit, buildBody, imageFromResponse, endpoint, accessToken, resetAuth, authMode,
  region, model,
};
