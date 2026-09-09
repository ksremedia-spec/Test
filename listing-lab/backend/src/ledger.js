/**
 * Listing Lab — credit ledger.
 *
 * WHY IT IS BUILT THIS WAY
 * This is the only part of the backend that touches money, so it is an
 * append-only event log and a balance is never stored anywhere. Every change is
 * an entry with a sign; the balance is the sum. That means a balance can always
 * be explained ("where did my credits go?") and a bug can never silently
 * overwrite one — the worst it can do is add a wrong entry, which is visible and
 * reversible.
 *
 * THE PRODUCT RULES THIS ENCODES (Kyle's, not invented here)
 *   - One credit currency.
 *   - Declutter / Empty Room / Twilight cost 1. Virtual Staging costs 2.
 *   - A credit buys up to THREE generation attempts on one photo + one
 *     transformation. Attempts are the meter: an agent who keeps regenerating
 *     without saving is spending their allowance, which is the intended
 *     behaviour, not an exploit to be blocked.
 *   - If the job ends with no compliant result, the credit goes back on the
 *     account in full. No money moves — this is not a card refund.
 *   - Purchased credits never expire.
 *   - There are no free monthly credits. Promotional grants exist as an entry
 *     type so a promo code can be honoured later without a schema change.
 *
 * IDEMPOTENCY
 * Stripe retries webhooks. Networks retry requests. Every entry carries a
 * caller-supplied `key`, unique per intended action, and re-applying an entry
 * with a key already in the log is a no-op that returns the existing entry.
 * Without this, one retried `checkout.session.completed` is free credits.
 */

export const ATTEMPTS_PER_CREDIT = 3;

/** Credit cost per transformation. The closed set — there is no prompt box. */
export const TRANSFORMATION_COST = Object.freeze({
  // Priced from measured delivery cost (28 Aug 2026): declutter ~$0.90-1.00
  // with the masked rescue behind it, empty ~$0.55 with hybrid retries,
  // staging ~$0.70, twilight ~$0.28. Twilight is the only genuinely light
  // one; everything that removes or adds contents carries retry weight.
  declutter: 2,
  empty: 2,
  twilight: 1,
  staging: 2,
});

/**
 * Pack pricing — Kyle's "Option A", 28 Aug 2026. Base rate ~$2/credit; the bulk
 * discount is real but modest (30-pack ≈5% off, 75-pack ≈8% off) after Kyle
 * said the earlier discounts were giving away too much. Cents, never floats.
 */
export const CREDIT_PACKS = Object.freeze([
  { id: 'pack_10', credits: 10, priceCents: 1999 },
  { id: 'pack_30', credits: 30, priceCents: 5699 },
  { id: 'pack_75', credits: 75, priceCents: 13799 },
]);

/**
 * The ONE Stripe event that is allowed to add credits.
 *
 * Stripe emits several events for a single payment — a Checkout purchase also
 * produces `payment_intent.succeeded`, `charge.succeeded` and others. Those carry
 * DIFFERENT event ids and DIFFERENT object ids, so no amount of de-duplication
 * will spot that they describe one purchase. Subscribing to two of them credits
 * the account twice, and it looks perfectly legitimate in the log.
 *
 * The defence is not clever code, it is restraint: the webhook endpoint
 * subscribes to exactly this event and ignores everything else. Stripe gives the
 * same advice — "only listen to event types your integration requires".
 */
export const CREDIT_GRANTING_EVENT = 'checkout.session.completed';

/**
 * Build the idempotency key for a credit-granting webhook.
 *
 * WHY NOT JUST THE EVENT ID
 * Stripe's own guidance: "Webhook endpoints might occasionally receive the same
 * event more than once… In some cases, two separate Event objects are generated
 * and sent. To identify these duplicates, use the ID of the object in
 * `data.object` along with the `event.type`."
 *
 * So an event id alone is the wrong key. Two Event objects for one completed
 * checkout have two ids; keyed on the id they both land and the customer gets
 * double credits. Keyed on the checkout session id they collapse into one, which
 * is what we want, because the session is the purchase.
 *
 * Retries of the same delivery are also covered — same session, same key.
 */
export function creditKeyFor({ objectId, eventType }) {
  if (!objectId) throw new LedgerError('OBJECT_ID_REQUIRED', 'A credit key needs the Stripe object id from data.object.');
  if (eventType !== CREDIT_GRANTING_EVENT) {
    throw new LedgerError('WRONG_EVENT_TYPE',
      `Only ${CREDIT_GRANTING_EVENT} may add credits.`,
      { eventType, allowed: CREDIT_GRANTING_EVENT });
  }
  return `${eventType}:${objectId}`;
}

export const ENTRY_TYPES = Object.freeze({
  PURCHASE: 'purchase',     // Stripe payment settled
  PROMO: 'promo',           // promo code honoured
  DEBIT: 'debit',           // a job started and took its credits
  RETURN: 'credit_return',  // a job produced nothing compliant, so its credits went back
  ADJUSTMENT: 'adjustment', // manual correction, always with a reason
});

const CREDITING = new Set([ENTRY_TYPES.PURCHASE, ENTRY_TYPES.PROMO]);

export class LedgerError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * An account's ledger. `entries` is the durable record; everything else is
 * derived on read so there is no second copy of the truth to fall out of sync.
 */
export class Ledger {
  constructor(entries = []) {
    this.entries = [...entries];
    this._keys = new Set(this.entries.map(e => e.key));
  }

  static from(entries) { return new Ledger(entries); }

  /** Sum of every delta. Never cached — this is cheap and always right. */
  get balance() {
    return this.entries.reduce((n, e) => n + e.delta, 0);
  }

  find(key) { return this.entries.find(e => e.key === key) || null; }

  entriesForJob(jobId) { return this.entries.filter(e => e.jobId === jobId); }

  /** Append, or return the existing entry when this key has already been applied. */
  _append(entry) {
    const existing = this.find(entry.key);
    if (existing) return { entry: existing, applied: false };
    if (!Number.isInteger(entry.delta)) {
      throw new LedgerError('INVALID_DELTA', 'Credit amounts must be whole numbers.', { delta: entry.delta });
    }
    // A ledger may never be driven negative. If this throws, a caller skipped
    // its balance check — better a loud failure than a customer in debt.
    if (this.balance + entry.delta < 0) {
      throw new LedgerError('INSUFFICIENT_CREDITS',
        'Not enough credits for this action.',
        { balance: this.balance, required: -entry.delta });
    }
    this.entries.push(entry);
    this._keys.add(entry.key);
    return { entry, applied: true };
  }

  /**
   * Credit an account from a settled Stripe payment.
   *
   * `key` MUST come from `creditKeyFor()`. Do not pass a raw Stripe event id —
   * see the note on that function for why that is not enough on its own.
   */
  purchase({ key, credits, packId = null, stripeEventId = null, at }) {
    if (!key) throw new LedgerError('KEY_REQUIRED', 'A purchase needs an idempotency key.');
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new LedgerError('INVALID_CREDITS', 'A purchase must add a positive whole number of credits.', { credits });
    }
    return this._append({
      key, type: ENTRY_TYPES.PURCHASE, delta: credits,
      packId, stripeEventId, jobId: null, at: at || nowISO(),
    });
  }

  /** Grant credits from a promo code. Same shape as a purchase, different origin. */
  promo({ key, credits, code = null, at }) {
    if (!key) throw new LedgerError('KEY_REQUIRED', 'A promo grant needs an idempotency key.');
    if (!Number.isInteger(credits) || credits <= 0) {
      throw new LedgerError('INVALID_CREDITS', 'A promo must add a positive whole number of credits.', { credits });
    }
    return this._append({
      key, type: ENTRY_TYPES.PROMO, delta: credits,
      code, jobId: null, at: at || nowISO(),
    });
  }

  /**
   * Take payment for a job up front. The job then owns up to three attempts.
   * Charging at the start — not per attempt — is what makes the return rule
   * simple: either the job delivered something, or the whole charge goes back.
   */
  debitForJob({ key, jobId, transformation, at }) {
    if (!key) throw new LedgerError('KEY_REQUIRED', 'A debit needs an idempotency key.');
    if (!jobId) throw new LedgerError('JOB_REQUIRED', 'A debit must name a job.');
    const cost = TRANSFORMATION_COST[transformation];
    if (!cost) {
      throw new LedgerError('UNKNOWN_TRANSFORMATION',
        'That transformation is not one Listing Lab offers.',
        { transformation, offered: Object.keys(TRANSFORMATION_COST) });
    }
    if (this.entries.some(e => e.jobId === jobId && e.type === ENTRY_TYPES.DEBIT && e.key !== key)) {
      throw new LedgerError('JOB_ALREADY_CHARGED', 'This job has already been charged.', { jobId });
    }
    if (this.balance < cost) {
      throw new LedgerError('INSUFFICIENT_CREDITS',
        'Not enough credits for this transformation.',
        { balance: this.balance, required: cost, transformation });
    }
    return this._append({
      key, type: ENTRY_TYPES.DEBIT, delta: -cost,
      jobId, transformation, attemptsAllowed: ATTEMPTS_PER_CREDIT, at: at || nowISO(),
    });
  }

  /**
   * Put the credits back on the account because nothing compliant came out.
   *
   * NOTE ON THE WORD: this is NOT a Stripe refund. No money moves and nothing is
   * returned to a card. The customer's credit balance goes back up and they can
   * spend it again. A card-level reversal (a dispute, or Kyle handing back
   * $54.99) is a separate concern this ledger does not handle today — when it is
   * built it will also need to claw back any unspent credits from that purchase.
   *
   * Refuses on a job that was never charged, one whose credits already went back,
   * or one that actually delivered — putting credits back on a delivered job
   * means the customer keeps the image and gets to make another one free.
   */
  returnCreditsForJob({ key, jobId, reason = 'no compliant result', delivered = false, at }) {
    if (!key) throw new LedgerError('KEY_REQUIRED', 'A credit return needs an idempotency key.');
    const existing = this.find(key);
    if (existing) return { entry: existing, applied: false };
    const debit = this.entries.find(e => e.jobId === jobId && e.type === ENTRY_TYPES.DEBIT);
    if (!debit) throw new LedgerError('NOTHING_TO_RETURN', 'That job was never charged.', { jobId });
    if (this.entries.some(e => e.jobId === jobId && e.type === ENTRY_TYPES.RETURN)) {
      throw new LedgerError('CREDITS_ALREADY_RETURNED', 'The credits for that job have already been returned.', { jobId });
    }
    if (delivered) {
      throw new LedgerError('JOB_DELIVERED', 'A job that delivered an image does not get its credits back.', { jobId });
    }
    return this._append({
      key, type: ENTRY_TYPES.RETURN, delta: -debit.delta,
      jobId, reason, at: at || nowISO(),
    });
  }

  /** Manual correction. Always requires a reason — an unexplained adjustment is a bug. */
  adjust({ key, credits, reason, actor, at }) {
    if (!key) throw new LedgerError('KEY_REQUIRED', 'An adjustment needs an idempotency key.');
    if (!reason) throw new LedgerError('REASON_REQUIRED', 'An adjustment must say why.');
    if (!Number.isInteger(credits) || credits === 0) {
      throw new LedgerError('INVALID_CREDITS', 'An adjustment must be a non-zero whole number.', { credits });
    }
    return this._append({
      key, type: ENTRY_TYPES.ADJUSTMENT, delta: credits,
      reason, actor: actor || 'admin', jobId: null, at: at || nowISO(),
    });
  }

  /** Plain-language history for the customer's account page, newest first. */
  statement() {
    return [...this.entries].reverse().map(e => ({
      at: e.at,
      delta: e.delta,
      description:
        e.type === ENTRY_TYPES.PURCHASE ? `Bought ${e.delta} credits`
        : e.type === ENTRY_TYPES.PROMO ? `Promo credit${e.delta === 1 ? '' : 's'} added`
        : e.type === ENTRY_TYPES.DEBIT ? `${labelFor(e.transformation)} started`
        : e.type === ENTRY_TYPES.RETURN ? `${labelFor(transformationOfJob(this.entries, e.jobId))} — no result delivered, credits returned`
        : e.reason,
    }));
  }
}

/**
 * Attempt accounting for one job. Separate from the ledger on purpose: attempts
 * are not money, they are what one debit entitles you to. Keeping them apart
 * means a regenerate can never accidentally post a second charge.
 */
export class JobAttempts {
  constructor(allowed = ATTEMPTS_PER_CREDIT) {
    this.allowed = allowed;
    this.used = 0;
    this.outcomes = [];
  }

  get remaining() { return Math.max(0, this.allowed - this.used); }
  get exhausted() { return this.remaining === 0; }

  /**
   * Consume one attempt. Called before generation, so a crash mid-generation
   * still spends the attempt — the alternative lets a failure loop run free.
   */
  consume() {
    if (this.exhausted) {
      throw new LedgerError('ATTEMPTS_EXHAUSTED',
        `All ${this.allowed} attempts for this credit have been used.`,
        { allowed: this.allowed });
    }
    this.used += 1;
    return this.remaining;
  }

  record(outcome) { this.outcomes.push(outcome); return this; }

  /** True when the job produced something deliverable. */
  get delivered() { return this.outcomes.some(o => o === 'delivered'); }

  /** A job is creditsReturnable once it is out of attempts with nothing delivered. */
  get creditsReturnable() { return this.exhausted && !this.delivered; }
}

function transformationOfJob(entries, jobId) {
  const d = entries.find(e => e.jobId === jobId && e.type === ENTRY_TYPES.DEBIT);
  return d && d.transformation;
}

function labelFor(t) {
  return { declutter: 'Declutter', empty: 'Empty Room', twilight: 'Twilight', staging: 'Virtual Staging' }[t] || 'Transformation';
}

function nowISO() { return new Date().toISOString(); }
