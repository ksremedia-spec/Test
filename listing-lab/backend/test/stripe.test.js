/**
 * Listing Lab — Stripe webhook verification tests.
 *
 * The first test proves the door is locked. The rest are the ways someone would
 * try the handle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyStripeWebhook, parseSignatureHeader, creditGrantFromEvent,
  StripeVerificationError, DEFAULT_TOLERANCE_SECONDS,
} from '../src/stripe.js';
import { Ledger, creditKeyFor, CREDIT_GRANTING_EVENT, CREDIT_PACKS } from '../src/ledger.js';

const SECRET = 'whsec_test_9f8e7d6c5b4a';
const NOW = 1_787_500_000;

const throwsCode = (fn, code) => assert.rejects(fn, err => {
  assert.ok(err instanceof StripeVerificationError, `expected StripeVerificationError, got ${err && err.name}`);
  assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
  return true;
});
const throwsCodeSync = (fn, code) => assert.throws(fn, err => {
  assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
  return true;
});

const enc = new TextEncoder();
async function sign(body, secret, ts) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const header = async (body, secret = SECRET, ts = NOW) => `t=${ts},v1=${await sign(body, secret, ts)}`;

const sessionEvent = (over = {}) => JSON.stringify({
  id: 'evt_1',
  type: CREDIT_GRANTING_EVENT,
  data: {
    object: {
      id: 'cs_test_abc',
      payment_status: 'paid',
      amount_total: 5699,
      currency: 'usd',
      metadata: { pack_id: 'pack_30', account_id: 'acct_kyle' },
      ...over,
    },
  },
});

/* ------------------------------------------------------------ the front door */

test('a genuine Stripe delivery is accepted', async () => {
  const body = sessionEvent();
  const event = await verifyStripeWebhook(body, await header(body), SECRET, { nowSeconds: NOW });
  assert.equal(event.id, 'evt_1');
  assert.equal(event.type, CREDIT_GRANTING_EVENT);
});

test('a forged request with no signature is refused', async () => {
  const body = sessionEvent();
  await throwsCode(() => verifyStripeWebhook(body, '', SECRET, { nowSeconds: NOW }), 'MISSING_SIGNATURE');
  await throwsCode(() => verifyStripeWebhook(body, undefined, SECRET, { nowSeconds: NOW }), 'MISSING_SIGNATURE');
});

test('a request signed with the wrong secret is refused', async () => {
  const body = sessionEvent();
  const bad = await header(body, 'whsec_attacker_guess');
  await throwsCode(() => verifyStripeWebhook(body, bad, SECRET, { nowSeconds: NOW }), 'SIGNATURE_MISMATCH');
});

test('a tampered body is refused even with a real signature', async () => {
  // Sign the honest 30-credit pack, then try to swap in the 75-credit one.
  const honest = sessionEvent();
  const sig = await header(honest);
  const tampered = sessionEvent({ metadata: { pack_id: 'pack_75', account_id: 'acct_kyle' } });
  await throwsCode(() => verifyStripeWebhook(tampered, sig, SECRET, { nowSeconds: NOW }), 'SIGNATURE_MISMATCH');
});

test('one flipped byte in the signature is refused', async () => {
  const body = sessionEvent();
  const good = await header(body);
  const flipped = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
  await throwsCode(() => verifyStripeWebhook(body, flipped, SECRET, { nowSeconds: NOW }), 'SIGNATURE_MISMATCH');
});

/* --------------------------------------------------------------- replay window */

test('a delivery captured and replayed hours later is refused', async () => {
  const body = sessionEvent();
  const sig = await header(body, SECRET, NOW);
  await throwsCode(
    () => verifyStripeWebhook(body, sig, SECRET, { nowSeconds: NOW + 4 * 3600 }),
    'TIMESTAMP_OUT_OF_TOLERANCE');
});

test('a delivery a few seconds old is fine — clocks drift', async () => {
  const body = sessionEvent();
  const sig = await header(body, SECRET, NOW);
  const event = await verifyStripeWebhook(body, sig, SECRET, { nowSeconds: NOW + 120 });
  assert.equal(event.id, 'evt_1');
});

test('a tolerance of zero is refused outright', async () => {
  const body = sessionEvent();
  const sig = await header(body);
  await throwsCode(
    () => verifyStripeWebhook(body, sig, SECRET, { nowSeconds: NOW, toleranceSeconds: 0 }),
    'BAD_TOLERANCE');
  assert.equal(DEFAULT_TOLERANCE_SECONDS, 300);
});

/* ------------------------------------------------------------ secret rolling */

test('both secrets work while a signing secret is being rolled', async () => {
  const OLD = 'whsec_old', NEW = 'whsec_new';
  const body = sessionEvent();
  // Stripe sends one signature per active secret during the overlap.
  const h = `t=${NOW},v1=${await sign(body, OLD, NOW)},v1=${await sign(body, NEW, NOW)}`;
  for (const s of [OLD, NEW]) {
    const event = await verifyStripeWebhook(body, h, [s], { nowSeconds: NOW });
    assert.equal(event.id, 'evt_1');
  }
});

test('the v0 test scheme is ignored — accepting it is a downgrade attack', async () => {
  const body = sessionEvent();
  const v0only = `t=${NOW},v0=${await sign(body, SECRET, NOW)}`;
  await throwsCode(() => verifyStripeWebhook(body, v0only, SECRET, { nowSeconds: NOW }), 'MALFORMED_SIGNATURE');
});

test('a header without a timestamp is refused', () => {
  throwsCodeSync(() => parseSignatureHeader('v1=abc'), 'MALFORMED_SIGNATURE');
  throwsCodeSync(() => parseSignatureHeader('t=notanumber,v1=abc'), 'MALFORMED_SIGNATURE');
});

test('a misconfigured server with no secret refuses everything', async () => {
  const body = sessionEvent();
  const sig = await header(body);
  await throwsCode(() => verifyStripeWebhook(body, sig, '', { nowSeconds: NOW }), 'NO_SECRET');
});

/* ----------------------------------------------------- reading the payment */

test('a paid session grants exactly the pack that was bought', () => {
  const grant = creditGrantFromEvent(JSON.parse(sessionEvent()));
  assert.equal(grant.credits, 30);
  assert.equal(grant.packId, 'pack_30');
  assert.equal(grant.accountId, 'acct_kyle');
  assert.equal(grant.objectId, 'cs_test_abc');
});

test('paying the 10-pack price cannot buy the 75-pack', () => {
  // The signature only proves Stripe sent it. It does not prove the numbers agree.
  const body = sessionEvent({ metadata: { pack_id: 'pack_75', account_id: 'acct_kyle' }, amount_total: 1999 });
  throwsCodeSync(() => creditGrantFromEvent(JSON.parse(body)), 'AMOUNT_MISMATCH');
});

test('a pack that does not exist grants nothing', () => {
  const body = sessionEvent({ metadata: { pack_id: 'pack_9999', account_id: 'acct_kyle' } });
  throwsCodeSync(() => creditGrantFromEvent(JSON.parse(body)), 'UNKNOWN_PACK');
});

test('a session that names no account grants nothing', () => {
  const body = sessionEvent({ metadata: { pack_id: 'pack_30' } });
  throwsCodeSync(() => creditGrantFromEvent(JSON.parse(body)), 'NO_ACCOUNT');
});

test('an unpaid session grants nothing', () => {
  const body = sessionEvent({ payment_status: 'unpaid' });
  assert.equal(creditGrantFromEvent(JSON.parse(body)), null);
});

test('a session paid in another currency grants nothing', () => {
  const body = sessionEvent({ currency: 'eur' });
  throwsCodeSync(() => creditGrantFromEvent(JSON.parse(body)), 'CURRENCY_MISMATCH');
});

test('any other Stripe event grants nothing', () => {
  for (const type of ['payment_intent.succeeded', 'charge.succeeded', 'customer.created']) {
    assert.equal(creditGrantFromEvent({ id: 'evt_x', type, data: { object: { id: 'pi_1' } } }), null);
  }
});

test('the pack prices here are the ones the ledger sells', () => {
  assert.deepEqual(CREDIT_PACKS.map(p => p.id), ['pack_10', 'pack_30', 'pack_75']);
});

/* ---------------------------------------------- verify and credit, end to end */

test('end to end: a real delivery credits once, and its replay does nothing', async () => {
  const l = new Ledger();
  const body = sessionEvent();
  const sig = await header(body);

  const event = await verifyStripeWebhook(body, sig, SECRET, { nowSeconds: NOW });
  const grant = creditGrantFromEvent(event);
  l.purchase({
    key: creditKeyFor({ objectId: grant.objectId, eventType: grant.eventType }),
    credits: grant.credits, packId: grant.packId, at: '2026-08-25T12:00:00.000Z',
  });
  assert.equal(l.balance, 30);

  // Stripe redelivers the same purchase under a second event id.
  const second = JSON.parse(body);
  second.id = 'evt_2';
  const secondBody = JSON.stringify(second);
  const secondEvent = await verifyStripeWebhook(secondBody, await header(secondBody), SECRET, { nowSeconds: NOW });
  const secondGrant = creditGrantFromEvent(secondEvent);
  const applied = l.purchase({
    key: creditKeyFor({ objectId: secondGrant.objectId, eventType: secondGrant.eventType }),
    credits: secondGrant.credits, at: '2026-08-25T12:00:00.000Z',
  });

  assert.notEqual(event.id, secondEvent.id, 'two different event ids');
  assert.equal(applied.applied, false, 'but one purchase');
  assert.equal(l.balance, 30);
});
