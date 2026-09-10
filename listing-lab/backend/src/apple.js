/**
 * Listing Lab — verifying Sign in with Apple.
 *
 * The identity token the iOS app hands over is a JWS (RS256) signed with one
 * of the keys Apple publishes at https://appleid.apple.com/auth/keys. Its
 * `sub` is the person's stable Apple id; its `email` may be a private-relay
 * address. It is checked HERE, on the server, with WebCrypto and no
 * libraries — the app is not a security boundary, and a lenient verifier is
 * how a stranger signs into someone else's account.
 *
 * Credits are NOT bought through Apple (decided 10 Sep 2026): the app opens
 * the website's Stripe Checkout in Safari and comes back, so there is no
 * receipt verification here. See startCheckout in worker.js.
 */

/** The app's bundle identifier: the audience of identity tokens. */
export const APP_BUNDLE_ID = 'com.horizonhomemedia.listinglab';
export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
/** Apple's keys rotate rarely; a day in memory is plenty, and an unknown kid refetches anyway. */
export const APPLE_KEYS_TTL_MS = 24 * 60 * 60 * 1000;

export class AppleVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppleVerificationError';
    this.code = code;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlToBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Uint8Array.from(atob(t), c => c.charCodeAt(0));
}
const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Split a compact JWS into its parts. `code` names the refusal when it is not one. */
function parseJws(token, code) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || parts.some(p => !p.length)) {
    throw new AppleVerificationError(code, 'That is not a signed token.');
  }
  let header, payload, signature;
  try {
    header = JSON.parse(dec.decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
    signature = b64urlToBytes(parts[2]);
  } catch {
    throw new AppleVerificationError(code, 'That is not a signed token.');
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
    throw new AppleVerificationError(code, 'That is not a signed token.');
  }
  return { header, payload, signature, signingInput: enc.encode(`${parts[0]}.${parts[1]}`) };
}

/* ------------------------------------------------------ Sign in with Apple */

let keyCache = { keys: null, fetchedAt: 0 };

/** Tests use this so one test's keys never leak into the next. */
export function resetAppleKeyCache() { keyCache = { keys: null, fetchedAt: 0 }; }

async function fetchAppleKeys() {
  let body;
  try {
    const res = await fetch(APPLE_JWKS_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new AppleVerificationError('APPLE_KEYS_UNREACHABLE', `Could not fetch Apple's signing keys: ${err?.message || err}`);
  }
  if (!Array.isArray(body?.keys)) {
    throw new AppleVerificationError('APPLE_KEYS_UNREACHABLE', "Apple's key set was not in the expected shape.");
  }
  return body.keys;
}

/**
 * Find the key a token names. Cached for a day; an unknown kid on a fresh
 * cache means Apple rotated, so refetch once before giving up — a rotation
 * must not lock every iPhone out until the cache happens to expire.
 */
async function appleKeyFor(kid, opts) {
  if (opts.keys) return opts.keys.find(k => k.kid === kid) || null;
  const now = opts.now ?? Date.now();
  const stale = !keyCache.keys || now - keyCache.fetchedAt > APPLE_KEYS_TTL_MS;
  if (stale) keyCache = { keys: await fetchAppleKeys(), fetchedAt: now };
  let key = keyCache.keys.find(k => k.kid === kid);
  if (!key && !stale) {
    keyCache = { keys: await fetchAppleKeys(), fetchedAt: now };
    key = keyCache.keys.find(k => k.kid === kid);
  }
  return key || null;
}

/**
 * Verify an identity token from ASAuthorizationAppleIDCredential.
 *
 * @param {string} token   the JWS, as the app received it
 * @param {object} [opts]  { audience, now, keys } — `keys` bypasses the JWKS fetch (tests)
 * @returns {Promise<{sub:string, email:string|null, emailVerified:boolean, claims:object}>}
 */
export async function verifyAppleIdentityToken(token, opts = {}) {
  const audience = opts.audience ?? APP_BUNDLE_ID;
  const now = opts.now ?? Date.now();
  const { header, payload, signature, signingInput } = parseJws(token, 'APPLE_TOKEN_MALFORMED');
  // Apple signs with RS256 and nothing else. Accepting the alg a token names
  // for itself is the classic JWT hole ("none", or an HMAC keyed on the public key).
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new AppleVerificationError('APPLE_TOKEN_ALG', 'Apple identity tokens are RS256 with a key id.');
  }
  const jwk = await appleKeyFor(header.kid, opts);
  if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new AppleVerificationError('APPLE_KEY_UNKNOWN', 'The token names a key Apple does not publish.');
  }
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput);
  } catch { ok = false; }
  if (!ok) throw new AppleVerificationError('APPLE_TOKEN_SIGNATURE', 'The identity token signature does not verify.');

  if (payload.iss !== APPLE_ISSUER) {
    throw new AppleVerificationError('APPLE_TOKEN_ISSUER', 'The identity token was not issued by Apple.');
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) {
    throw new AppleVerificationError('APPLE_TOKEN_AUDIENCE', 'The identity token was issued for a different app.');
  }
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) {
    throw new AppleVerificationError('APPLE_TOKEN_EXPIRED', 'The identity token has expired.');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new AppleVerificationError('APPLE_TOKEN_MALFORMED', 'The identity token names no user.');
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' && payload.email ? payload.email : null,
    // Apple sends "true" as a string in some tokens and a boolean in others.
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    claims: payload,
  };
}
