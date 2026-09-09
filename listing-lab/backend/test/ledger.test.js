/**
 * Listing Lab — credit ledger tests.
 *
 * Every test below is a way Kyle loses money or a customer gets wrongly charged.
 * That is the only reason any of them exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Ledger, JobAttempts, LedgerError,
  TRANSFORMATION_COST, ATTEMPTS_PER_CREDIT, CREDIT_PACKS,
  creditKeyFor, CREDIT_GRANTING_EVENT,
} from '../src/ledger.js';

/** assert.throws matches on message; our contract is the `code`. Check that instead. */
const throwsCode = (fn, code) => assert.throws(fn, err => {
  assert.ok(err instanceof LedgerError, `expected a LedgerError, got ${err && err.name}`);
  assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
  return true;
});

const AT = '2026-08-25T12:00:00.000Z';
const stocked = (credits = 10) => {
  const l = new Ledger();
  l.purchase({ key: 'stripe_evt_seed', credits, packId: 'pack_10', at: AT });
  return l;
};

test('a new account has no credits', () => {
  assert.equal(new Ledger().balance, 0);
});

test('the product price list is what Kyle set', () => {
  // Repriced 28 Aug 2026 (Kyle): everything that changes a room's contents
  // carries retry weight and costs 2; twilight is the light one at 1.
  assert.equal(TRANSFORMATION_COST.declutter, 2);
  assert.equal(TRANSFORMATION_COST.empty, 2);
  assert.equal(TRANSFORMATION_COST.twilight, 1);
  assert.equal(TRANSFORMATION_COST.staging, 2);
  assert.equal(ATTEMPTS_PER_CREDIT, 3);
  assert.deepEqual(CREDIT_PACKS.map(p => [p.credits, p.priceCents]),
    [[10, 1999], [30, 5699], [75, 13799]]);
});

/* ---------------------------------------------------------------- purchases */

test('a Stripe webhook replay does not hand out free credits', () => {
  const l = new Ledger();
  const first = l.purchase({ key: 'stripe_evt_abc', credits: 30, at: AT });
  const replay = l.purchase({ key: 'stripe_evt_abc', credits: 30, at: AT });
  assert.equal(first.applied, true);
  assert.equal(replay.applied, false, 'the replay must be a no-op');
  assert.equal(l.balance, 30, 'balance must not double');
  assert.equal(l.entries.length, 1);
});

test('two genuinely different payments both count', () => {
  const l = new Ledger();
  l.purchase({ key: 'stripe_evt_1', credits: 10, at: AT });
  l.purchase({ key: 'stripe_evt_2', credits: 10, at: AT });
  assert.equal(l.balance, 20);
});

test('a purchase cannot add a fraction or a negative', () => {
  const l = new Ledger();
  throwsCode(() => l.purchase({ key: 'a', credits: 2.5, at: AT }), 'INVALID_CREDITS');
  throwsCode(() => l.purchase({ key: 'b', credits: -5, at: AT }), 'INVALID_CREDITS');
  assert.equal(l.balance, 0);
});


/* ------------------------------------------------- the Stripe duplicate traps */

test('two Event objects for ONE checkout only credit once', () => {
  // Stripe: "In some cases, two separate Event objects are generated and sent."
  // Different event ids, same checkout session. Keying on the event id would
  // credit twice; keying on the session collapses them.
  const l = new Ledger();
  const sessionId = 'cs_test_a1b2c3';
  const k1 = creditKeyFor({ objectId: sessionId, eventType: CREDIT_GRANTING_EVENT });
  const k2 = creditKeyFor({ objectId: sessionId, eventType: CREDIT_GRANTING_EVENT });
  assert.equal(k1, k2, 'the same purchase must produce the same key');
  l.purchase({ key: k1, credits: 75, at: AT });
  const second = l.purchase({ key: k2, credits: 75, at: AT });
  assert.equal(second.applied, false);
  assert.equal(l.balance, 75, 'one purchase, one grant');
});

test('a different checkout session is a different purchase', () => {
  const l = new Ledger();
  l.purchase({ key: creditKeyFor({ objectId: 'cs_1', eventType: CREDIT_GRANTING_EVENT }), credits: 10, at: AT });
  l.purchase({ key: creditKeyFor({ objectId: 'cs_2', eventType: CREDIT_GRANTING_EVENT }), credits: 10, at: AT });
  assert.equal(l.balance, 20);
});

test('no other Stripe event may add credits', () => {
  // A Checkout purchase also emits payment_intent.succeeded and charge.succeeded.
  // Honouring any of those alongside the session event is a double grant that
  // de-duplication cannot see, because they are genuinely different objects.
  for (const t of ['payment_intent.succeeded', 'charge.succeeded', 'invoice.paid']) {
    throwsCode(() => creditKeyFor({ objectId: 'pi_123', eventType: t }), 'WRONG_EVENT_TYPE');
  }
  assert.equal(CREDIT_GRANTING_EVENT, 'checkout.session.completed');
});

test('a credit key cannot be built without the Stripe object id', () => {
  throwsCode(() => creditKeyFor({ eventType: CREDIT_GRANTING_EVENT }), 'OBJECT_ID_REQUIRED');
});

/* ------------------------------------------------------------------- debits */

test('staging costs two credits, the others cost one', () => {
  const l = stocked();
  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  assert.equal(l.balance, 8);
  l.debitForJob({ key: 'j2:debit', jobId: 'j2', transformation: 'twilight', at: AT });
  assert.equal(l.balance, 7);
});

test('a transformation Listing Lab does not offer is refused', () => {
  const l = stocked();
  throwsCode(() => l.debitForJob({ key: 'j:debit', jobId: 'j', transformation: 'sky_replacement', at: AT }), 'UNKNOWN_TRANSFORMATION');
  assert.equal(l.balance, 10);
});

test('a job cannot be charged twice', () => {
  const l = stocked();
  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  throwsCode(() => l.debitForJob({ key: 'j1:debit:again', jobId: 'j1', transformation: 'staging', at: AT }), 'JOB_ALREADY_CHARGED');
  assert.equal(l.balance, 8);
});

test('a retried start request charges once', () => {
  const l = stocked();
  const a = l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  const b = l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  assert.equal(a.applied, true);
  assert.equal(b.applied, false);
  assert.equal(l.balance, 8);
});

test('an empty account cannot start a job, and never goes negative', () => {
  const l = new Ledger();
  throwsCode(() => l.debitForJob({ key: 'j:debit', jobId: 'j', transformation: 'declutter', at: AT }), 'INSUFFICIENT_CREDITS');
  assert.equal(l.balance, 0);
});

test('one credit is not enough for staging', () => {
  const l = stocked(1);
  throwsCode(() => l.debitForJob({ key: 'j:debit', jobId: 'j', transformation: 'staging', at: AT }), 'INSUFFICIENT_CREDITS');
  assert.equal(l.balance, 1, 'the credit stays put');
});

/* --------------------------------------------------- credits going back */

test('a job that delivers nothing gets the credits back in full', () => {
  const l = stocked();
  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  assert.equal(l.balance, 8);
  l.returnCreditsForJob({ key: 'j1:return', jobId: 'j1', at: AT });
  assert.equal(l.balance, 10, 'staging puts both credits back, not one');
});

test('a job cannot have its credits returned twice', () => {
  const l = stocked();
  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'declutter', at: AT });
  l.returnCreditsForJob({ key: 'j1:return', jobId: 'j1', at: AT });
  throwsCode(() => l.returnCreditsForJob({ key: 'j1:return:again', jobId: 'j1', at: AT }), 'CREDITS_ALREADY_RETURNED');
  assert.equal(l.balance, 10);
});

test('a retried credit-return request returns once', () => {
  const l = stocked();
  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'declutter', at: AT });
  l.returnCreditsForJob({ key: 'j1:return', jobId: 'j1', at: AT });
  const replay = l.returnCreditsForJob({ key: 'j1:return', jobId: 'j1', at: AT });
  assert.equal(replay.applied, false);
  assert.equal(l.balance, 10);
});

test('a job that delivered an image does not get its credits back', () => {
  const l = stocked();
  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  throwsCode(() => l.returnCreditsForJob({ key: 'j1:return', jobId: 'j1', delivered: true, at: AT }), 'JOB_DELIVERED');
  assert.equal(l.balance, 8, 'the work was delivered, so it stays paid for');
});

test('a job that was never charged has no credits to return', () => {
  const l = stocked();
  throwsCode(() => l.returnCreditsForJob({ key: 'ghost:return', jobId: 'ghost', at: AT }), 'NOTHING_TO_RETURN');
  assert.equal(l.balance, 10);
});

/* ----------------------------------------------------------------- attempts */

test('one credit buys exactly three attempts', () => {
  const a = new JobAttempts();
  assert.equal(a.remaining, 3);
  a.consume(); a.consume(); a.consume();
  assert.equal(a.remaining, 0);
  throwsCode(() => a.consume(), 'ATTEMPTS_EXHAUSTED');
});

test('regenerating without saving spends the allowance — that is the meter', () => {
  const a = new JobAttempts();
  a.consume(); a.record('rejected');
  a.consume(); a.record('rejected');
  assert.equal(a.remaining, 1, 'two throwaway regenerations cost two attempts');
  assert.equal(a.delivered, false);
});

test('a job is creditsReturnable only once it is out of attempts with nothing delivered', () => {
  const a = new JobAttempts();
  a.consume(); a.record('rejected');
  assert.equal(a.creditsReturnable, false, 'still has attempts left — not finished yet');
  a.consume(); a.record('rejected');
  a.consume(); a.record('rejected');
  assert.equal(a.creditsReturnable, true);
});

test('a delivered job is never creditsReturnable, even with attempts to spare', () => {
  const a = new JobAttempts();
  a.consume(); a.record('delivered');
  assert.equal(a.delivered, true);
  assert.equal(a.creditsReturnable, false);
  a.consume(); a.consume();
  assert.equal(a.exhausted, true);
  assert.equal(a.creditsReturnable, false, 'attempts ran out AFTER delivery — credits still stay spent');
});

/* -------------------------------------------------- the whole journey, twice */

test('full journey: buy, fail a staging job, get the credits back, succeed on the retry', () => {
  const l = stocked(10);
  const a1 = new JobAttempts();

  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  assert.equal(l.balance, 8);
  for (let i = 0; i < 3; i++) { a1.consume(); a1.record('rejected'); }
  assert.equal(a1.creditsReturnable, true);
  l.returnCreditsForJob({ key: 'j1:return', jobId: 'j1', delivered: a1.delivered, at: AT });
  assert.equal(l.balance, 10, 'a failed job costs the customer nothing');

  const a2 = new JobAttempts();
  l.debitForJob({ key: 'j2:debit', jobId: 'j2', transformation: 'staging', at: AT });
  a2.consume(); a2.record('rejected');
  a2.consume(); a2.record('delivered');
  assert.equal(a2.creditsReturnable, false);
  assert.equal(l.balance, 8, 'delivered work is paid for');
});

test('purchased credits never expire — no entry type can take them away on a date', () => {
  const l = stocked(10);
  const kinds = new Set(l.entries.map(e => e.type));
  assert.ok(!kinds.has('expiry'), 'there is deliberately no expiry mechanism');
  assert.equal(l.balance, 10);
});

/* --------------------------------------------------------------- statements */

test('the statement reads in plain language, newest first', () => {
  const l = stocked(10);
  l.debitForJob({ key: 'j1:debit', jobId: 'j1', transformation: 'staging', at: AT });
  l.returnCreditsForJob({ key: 'j1:return', jobId: 'j1', at: AT });
  const s = l.statement();
  assert.equal(s.length, 3);
  assert.match(s[0].description, /no result delivered, credits returned/);
  assert.equal(s[0].delta, 2);
  assert.match(s[1].description, /Virtual Staging started/);
  assert.equal(s[1].delta, -2);
  assert.match(s[2].description, /Bought 10 credits/);
});

test('an adjustment must say why', () => {
  const l = stocked();
  throwsCode(() => l.adjust({ key: 'adj1', credits: 5, at: AT }), 'REASON_REQUIRED');
  l.adjust({ key: 'adj2', credits: 5, reason: 'goodwill after an outage', actor: 'kyle', at: AT });
  assert.equal(l.balance, 15);
});

test('the balance is always the sum of the log — there is no second copy', () => {
  const l = stocked(30);
  l.debitForJob({ key: 'a:d', jobId: 'a', transformation: 'staging', at: AT });
  l.debitForJob({ key: 'b:d', jobId: 'b', transformation: 'twilight', at: AT });
  l.returnCreditsForJob({ key: 'a:r', jobId: 'a', at: AT });
  const rebuilt = Ledger.from(l.entries);
  assert.equal(rebuilt.balance, l.balance);
  assert.equal(l.balance, l.entries.reduce((n, e) => n + e.delta, 0));
});
