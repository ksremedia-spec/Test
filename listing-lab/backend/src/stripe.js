/**
 * Listing Lab — Stripe webhook verification and interpretation.
 *
 * WHY SIGNATURE VERIFICATION IS THE IMPORTANT PART
 * A webhook endpoint is a public URL that grants credits. Without verifying that
 * a request actually came from Stripe, anyone who discovers the address can POST
 * `{"type":"checkout.session.completed", ...}` and mint themselves an unlimited
 * balance. That is a bigger hole than every duplicate-delivery case combined,
 * because a duplicate costs one pack and this costs everything.
 *
 * Stripe signs each delivery with HMAC-SHA256 over "<timestamp>.<raw body>" using
 * the endpoint's signing secret, and puts it in the `Stripe-Signature` header:
 *
 *   t=1492774577,v1=5257a869…,v0=6ffbb59b…
 *
 * Three details that are easy to get wrong and each fatal:
 *   - The RAW body must be signed, byte for byte. Parsing the JSON and
 *     re-stringifying it changes the bytes and verification fails.
 *   - Ignore every scheme that is not `v1`. `v0` is a test-only scheme and
 *     accepting it is a downgrade attack.
 *   - There can be SEVERAL v1 signatures at once, because rolling the signing
 *     secret keeps the old one valid for up to 24 hours. Any one matching is a
 *     pass, so a secret can be rotated without downtime.
 */

import { CREDIT_PACKS, CREDIT_GRANTING_EVENT } from './ledger.js';

export class StripeVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StripeVerificationError';
    this.code = code;
  }
}

/** Default window between Stripe's timestamp and now. Stripe's own libraries use 5 minutes. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Parse `t=…,v1=…,v1=…` into a timestamp and the v1 signatures. Everything else is dropped. */
export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || !header.length) {
    throw new StripeVerificationError('MISSING_SIGNATURE', 'No Stripe-Signature header on the request.');
  }
  let timestamp = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const scheme = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (scheme === 't') timestamp = value;
    // v0 is deliberately ignored — accepting it is a downgrade attack.
    else if (scheme === 'v1') v1.push(value);
  }
  if (timestamp === null || !/^\d+$/.test(timestamp)) {
    throw new StripeVerificationError('MALFORMED_SIGNATURE', 'The Stripe-Signature header has no usable timestamp.');
  }
  if (!v1.length) {
    throw new StripeVerificationError('MALFORMED_SIGNATURE', 'The Stripe-Signature header has no v1 signature.');
  }
  return { timestamp: Number(timestamp), signatures: v1 };
}

const enc = new TextEncoder();

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare without leaking timing information.
 * A naive `===` returns faster the earlier two strings differ, which lets an
 * attacker discover a valid signature one character at a time.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Stripe webhook delivery.
 *
 * @param {string} rawBody  the request body EXACTLY as received, unparsed
 * @param {string} header   the Stripe-Signature header
 * @param {string|string[]} secrets  the whsec_… signing secret(s); pass both while rolling
 * @param {object} [opts]   { toleranceSeconds, nowSeconds }
 * @returns {Promise<object>} the parsed event, only if the signature is good
 */
export async function verifyStripeWebhook(rawBody, header, secrets, opts = {}) {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (tolerance <= 0) {
    // Stripe: "Don't use a tolerance value of 0" — it disables the recency check
    // and re-opens the replay attack the timestamp exists to close.
    throw new StripeVerificationError('BAD_TOLERANCE', 'A tolerance of zero disables replay protection.');
  }
  const secretList = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  if (!secretList.length) {
    throw new StripeVerificationError('NO_SECRET', 'No webhook signing secret is configured.');
  }

  const { timestamp, signatures } = parseSignatureHeader(header);

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new StripeVerificationError('TIMESTAMP_OUT_OF_TOLERANCE',
      'This delivery is too old to accept — it may be a replay.');
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  let matched = false;
  for (const secret of secretList) {
    const expected = await hmacSha256Hex(secret, signedPayload);
    // Check every offered signature rather than stopping early, so the work done
    // does not depend on which one matches.
    for (const candidate of signatures) {
      if (timingSafeEqual(expected, candidate)) matched = true;
    }
  }
  if (!matched) {
    throw new StripeVerificationError('SIGNATURE_MISMATCH',
      'The signature does not match — this request did not come from Stripe.');
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { throw new StripeVerificationError('MALFORMED_BODY', 'The request body is not valid JSON.'); }
  if (!event || typeof event !== 'object' || !event.id || !event.type) {
    throw new StripeVerificationError('MALFORMED_BODY', 'The request body is not a Stripe event.');
  }
  return event;
}

/**
 * Turn a verified event into a credit grant, or null if it grants nothing.
 *
 * Refuses to guess. The pack must be named in the session metadata AND the amount
 * actually paid must equal that pack's price — otherwise a tampered Checkout
 * session could claim the 75-credit pack for the price of the 10.
 */
export function creditGrantFromEvent(event) {
  if (event.type !== CREDIT_GRANTING_EVENT) return null;

  const session = event.data?.object;
  if (!session?.id) {
    throw new StripeVerificationError('NO_SESSION', 'The event carries no checkout session.');
  }
  if (session.payment_status !== 'paid') return null;

  const packId = session.metadata?.pack_id;
  const accountId = session.metadata?.account_id;
  if (!accountId) {
    throw new StripeVerificationError('NO_ACCOUNT', 'The checkout session does not say whose account to credit.');
  }
  const pack = CREDIT_PACKS.find(p => p.id === packId);
  if (!pack) {
    throw new StripeVerificationError('UNKNOWN_PACK',
      `The checkout session names a pack that does not exist: ${packId}`);
  }
  if (session.amount_total !== pack.priceCents) {
    throw new StripeVerificationError('AMOUNT_MISMATCH',
      `Paid ${session.amount_total} but ${pack.id} costs ${pack.priceCents}.`);
  }
  if (session.currency && session.currency.toLowerCase() !== 'usd') {
    throw new StripeVerificationError('CURRENCY_MISMATCH',
      `Packs are priced in USD; this session paid in ${session.currency}.`);
  }

  return {
    accountId,
    credits: pack.credits,
    packId: pack.id,
    objectId: session.id,
    eventType: event.type,
    eventId: event.id,
  };
}
