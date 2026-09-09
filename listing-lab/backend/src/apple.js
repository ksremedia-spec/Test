/**
 * Listing Lab — verifying what Apple signs.
 *
 * Two things arrive from the iOS app that only Apple could have produced, and
 * both are checked HERE, on the server, with WebCrypto and no libraries:
 *
 *   1. The identity token from Sign in with Apple — a JWS (RS256) signed with
 *      one of the keys Apple publishes at https://appleid.apple.com/auth/keys.
 *      Its `sub` is the person's stable Apple id; its `email` may be a
 *      private-relay address.
 *
 *   2. An App Store transaction — a JWS (ES256) whose header carries the
 *      signing certificate chain (`x5c`). The chain must lead to "Apple Root
 *      CA - G3", which is the one thing the server holds in advance
 *      (src/apple-root.js). A transaction that verifies is money Apple has
 *      already collected; the ledger key `iap:<transactionId>` makes replaying
 *      it a no-op, exactly as a Stripe session id does.
 *
 * Why the checks are strict: the app is not a security boundary. Anyone can
 * POST to these endpoints with anything. Free credits are what a lenient
 * verifier hands out, so every failure here is a refusal with a named code.
 */

import { APPLE_ROOT_CA_G3_DER } from './apple-root.js';

/** The app's bundle identifier: the audience of identity tokens and the bundleId of transactions. */
export const APP_BUNDLE_ID = 'com.horizonhomemedia.listinglab';
export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
/** Apple's keys rotate rarely; a day in memory is plenty, and an unknown kid refetches anyway. */
export const APPLE_KEYS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The consumables sold in the app, mirroring CREDIT_PACKS in ledger.js. The
 * product ids are what the owner creates in App Store Connect; the credits
 * are what a verified transaction for that id grants. Prices live in App
 * Store Connect, not here — Apple collects the money, this only counts it.
 */
export const IAP_PRODUCTS = Object.freeze({
  'com.horizonhomemedia.listinglab.credits10': { credits: 10, packId: 'pack_10' },
  'com.horizonhomemedia.listinglab.credits30': { credits: 30, packId: 'pack_30' },
  'com.horizonhomemedia.listinglab.credits75': { credits: 75, packId: 'pack_75' },
});

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

/* ------------------------------------------------------ App Store purchases */

const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  prime256v1: '1.2.840.10045.3.1.7',
  secp384r1: '1.3.132.0.34',
  secp521r1: '1.3.132.0.35',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  ecdsaSha512: '1.2.840.10045.4.3.4',
  rsaSha256: '1.2.840.113549.1.1.11',
  rsaSha384: '1.2.840.113549.1.1.12',
  rsaSha512: '1.2.840.113549.1.1.13',
  // Apple's own markers: the WWDR intermediate, and a certificate allowed to
  // sign App Store receipts and transactions. Apple's guidance is to check
  // both so a certificate Apple issued for something else cannot vouch for
  // a purchase.
  appleWwdrIntermediate: '1.2.840.113635.100.6.2.1',
  appleReceiptSigning: '1.2.840.113635.100.6.11.1',
};

const CURVES = {
  [OID.prime256v1]: { name: 'P-256', size: 32 },
  [OID.secp384r1]: { name: 'P-384', size: 48 },
  [OID.secp521r1]: { name: 'P-521', size: 66 },
};

const SIG_ALGS = {
  [OID.ecdsaSha256]: { kind: 'ECDSA', hash: 'SHA-256' },
  [OID.ecdsaSha384]: { kind: 'ECDSA', hash: 'SHA-384' },
  [OID.ecdsaSha512]: { kind: 'ECDSA', hash: 'SHA-512' },
  [OID.rsaSha256]: { kind: 'RSA', hash: 'SHA-256' },
  [OID.rsaSha384]: { kind: 'RSA', hash: 'SHA-384' },
  [OID.rsaSha512]: { kind: 'RSA', hash: 'SHA-512' },
};

/*
 * A minimal DER reader. Certificates are nested tag-length-value records;
 * this walks them without decoding anything it does not need. Every offset is
 * bounds-checked so a malformed certificate is a refusal, not a crash.
 */
const chainError = () => new AppleVerificationError('IAP_CHAIN', 'The certificate chain could not be read.');

function derNode(bytes, pos) {
  if (pos + 2 > bytes.length) throw chainError();
  const tag = bytes[pos];
  let i = pos + 1;
  let len = bytes[i++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || i + n > bytes.length) throw chainError();
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + bytes[i++];
  }
  if (i + len > bytes.length) throw chainError();
  return { tag, pos, start: i, end: i + len };
}

function derChildren(bytes, node) {
  const out = [];
  let p = node.start;
  while (p < node.end) {
    const c = derNode(bytes, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

function derOid(bytes, node) {
  if (node.tag !== 0x06) throw chainError();
  const b = bytes.subarray(node.start, node.end);
  if (!b.length) throw chainError();
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ) → epoch ms. */
function derTime(bytes, node) {
  const s = dec.decode(bytes.subarray(node.start, node.end));
  let m;
  if (node.tag === 0x17 && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    const yy = Number(m[1]);
    return Date.UTC(yy < 50 ? 2000 + yy : 1900 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (node.tag === 0x18 && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  throw chainError();
}

/** Read the parts of an X.509 certificate the verifier needs. */
export function parseCertificate(der) {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der);
  const cert = derNode(bytes, 0);
  if (cert.tag !== 0x30 || cert.end !== bytes.length) throw chainError();
  const [tbs, sigAlg, sigVal] = derChildren(bytes, cert);
  if (!tbs || !sigAlg || !sigVal || tbs.tag !== 0x30 || sigVal.tag !== 0x03) throw chainError();

  const fields = derChildren(bytes, tbs);
  let i = fields[0]?.tag === 0xa0 ? 1 : 0;          // [0] EXPLICIT version, when present
  const validity = fields[i + 3];
  const spki = fields[i + 5];
  if (!validity || !spki || validity.tag !== 0x30 || spki.tag !== 0x30) throw chainError();
  const [notBefore, notAfter] = derChildren(bytes, validity);
  const [spkiAlg] = derChildren(bytes, spki);
  const [keyAlgOid, keyParams] = derChildren(bytes, spkiAlg);
  const keyAlg = derOid(bytes, keyAlgOid);
  const curve = keyAlg === OID.ecPublicKey && keyParams ? derOid(bytes, keyParams) : null;

  const extensionOids = [];
  const extBlock = fields.find(f => f.tag === 0xa3);
  if (extBlock) {
    const [seq] = derChildren(bytes, extBlock);
    for (const ext of derChildren(bytes, seq)) {
      const [oid] = derChildren(bytes, ext);
      extensionOids.push(derOid(bytes, oid));
    }
  }

  return {
    der: bytes,
    tbs: bytes.subarray(tbs.pos, tbs.end),
    signatureAlgorithm: derOid(bytes, derChildren(bytes, sigAlg)[0]),
    // A BIT STRING's first content byte counts unused bits; a signature has none.
    signature: bytes.subarray(sigVal.start + 1, sigVal.end),
    spki: bytes.subarray(spki.pos, spki.end),
    keyAlgorithm: keyAlg,
    curve,
    notBefore: derTime(bytes, notBefore),
    notAfter: derTime(bytes, notAfter),
    extensionOids,
  };
}

/** Import a certificate's public key for the signature algorithm it will check. */
async function keyOf(cert, alg) {
  if (cert.keyAlgorithm === OID.ecPublicKey) {
    const curve = CURVES[cert.curve];
    if (!curve || alg.kind !== 'ECDSA') throw chainError();
    return crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
  }
  if (cert.keyAlgorithm === OID.rsaEncryption && alg.kind === 'RSA') {
    return crypto.subtle.importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash: alg.hash }, false, ['verify']);
  }
  throw chainError();
}

/** X.509 ECDSA signatures are DER SEQUENCE { r, s }; WebCrypto wants r‖s at the curve's width. */
function ecdsaDerToRaw(sig, size) {
  const seq = derNode(sig, 0);
  const [r, s] = derChildren(sig, seq);
  if (!r || !s || r.tag !== 0x02 || s.tag !== 0x02) throw chainError();
  const fit = n => {
    let b = sig.subarray(n.start, n.end);
    while (b.length > size && b[0] === 0) b = b.subarray(1);
    if (b.length > size) throw chainError();
    const out = new Uint8Array(size);
    out.set(b, size - b.length);
    return out;
  };
  const out = new Uint8Array(size * 2);
  out.set(fit(r), 0);
  out.set(fit(s), size);
  return out;
}

/** Was `cert` signed by `issuer`'s key? */
async function certSignedBy(cert, issuer) {
  const alg = SIG_ALGS[cert.signatureAlgorithm];
  if (!alg) return false;
  try {
    const key = await keyOf(issuer, alg);
    if (alg.kind === 'ECDSA') {
      const raw = ecdsaDerToRaw(cert.signature, CURVES[issuer.curve].size);
      return crypto.subtle.verify({ name: 'ECDSA', hash: alg.hash }, key, raw, cert.tbs);
    }
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, cert.signature, cert.tbs);
  } catch {
    return false;
  }
}

/**
 * Verify a signed transaction (`Transaction.jwsRepresentation` from StoreKit 2).
 *
 * @param {string} jws
 * @param {object} [opts]  { roots: Uint8Array[] (DER trust anchors; default Apple Root CA - G3),
 *                           bundleId, allowSandbox, now }
 * @returns {Promise<{transactionId, productId, credits, packId, environment, payload}>}
 */
export async function verifyAppStoreTransaction(jws, opts = {}) {
  const roots = (opts.roots ?? [APPLE_ROOT_CA_G3_DER]).filter(r => r && r.length);
  if (!roots.length) {
    throw new AppleVerificationError('IAP_ROOT_NOT_CONFIGURED',
      "Apple's root certificate is not configured — see src/apple-root.js.");
  }
  const bundleId = opts.bundleId ?? APP_BUNDLE_ID;
  const now = opts.now ?? Date.now();

  const { header, payload, signature, signingInput } = parseJws(jws, 'IAP_MALFORMED');
  if (header.alg !== 'ES256') {
    throw new AppleVerificationError('IAP_ALG', 'App Store transactions are signed with ES256.');
  }
  if (!Array.isArray(header.x5c) || header.x5c.length < 2 || header.x5c.length > 5) {
    throw new AppleVerificationError('IAP_CHAIN', 'The transaction carries no certificate chain.');
  }
  let chain;
  try { chain = header.x5c.map(c => parseCertificate(b64ToBytes(c))); }
  catch (err) { if (err instanceof AppleVerificationError) throw err; throw chainError(); }

  // The chain reads leaf → intermediate(s) → root. Each link must be signed by
  // the next, and the far end must be one of OUR roots: either the very
  // certificate we hold, or something our root signed.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!(await certSignedBy(chain[i], chain[i + 1]))) {
      throw new AppleVerificationError('IAP_CHAIN', 'A certificate in the chain was not signed by the next one.');
    }
  }
  const last = chain[chain.length - 1];
  let anchored = roots.some(r => bytesEqual(r, last.der));
  if (!anchored) {
    for (const r of roots) {
      let root;
      try { root = parseCertificate(r); } catch { continue; }
      if (await certSignedBy(last, root)) { anchored = true; break; }
    }
  }
  if (!anchored) {
    throw new AppleVerificationError('IAP_UNTRUSTED_ROOT', 'The certificate chain does not lead to Apple.');
  }
  for (const c of chain) {
    if (now < c.notBefore || now > c.notAfter) {
      throw new AppleVerificationError('IAP_CERT_EXPIRED', 'A certificate in the chain is not currently valid.');
    }
  }
  const leaf = chain[0];
  if (!leaf.extensionOids.includes(OID.appleReceiptSigning) ||
      !chain[1].extensionOids.includes(OID.appleWwdrIntermediate)) {
    throw new AppleVerificationError('IAP_CERT_PURPOSE', 'The signing certificate is not one Apple issues for the App Store.');
  }

  let ok = false;
  try {
    const key = await keyOf(leaf, { kind: 'ECDSA' });
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, signingInput);
  } catch { ok = false; }
  if (!ok) throw new AppleVerificationError('IAP_SIGNATURE', 'The transaction signature does not verify.');

  if (payload.bundleId !== bundleId) {
    throw new AppleVerificationError('IAP_WRONG_APP', 'That purchase belongs to a different app.');
  }
  if (payload.environment !== 'Production' && !(payload.environment === 'Sandbox' && opts.allowSandbox)) {
    throw new AppleVerificationError('IAP_SANDBOX', `Transactions from the ${payload.environment || 'unknown'} environment are not accepted.`);
  }
  const product = IAP_PRODUCTS[payload.productId];
  if (!product) {
    throw new AppleVerificationError('IAP_UNKNOWN_PRODUCT', 'That product is not one Listing Lab sells.');
  }
  if (payload.revocationDate) {
    throw new AppleVerificationError('IAP_REVOKED', 'Apple has revoked that purchase.');
  }
  const transactionId = payload.transactionId;
  if (transactionId == null || (typeof transactionId !== 'string' && typeof transactionId !== 'number') || String(transactionId) === '') {
    throw new AppleVerificationError('IAP_MALFORMED', 'The transaction has no id.');
  }
  return {
    transactionId: String(transactionId),
    productId: payload.productId,
    credits: product.credits,
    packId: product.packId,
    environment: payload.environment,
    payload,
  };
}
