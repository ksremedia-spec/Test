/**
 * Listing Lab — buying credits from the iPhone app (decided 10 Sep 2026).
 *
 * The app opens the SAME hosted Stripe Checkout the web uses. The one
 * difference is where Stripe sends the person afterwards: the app asks with
 * `platform: "ios"` and gets return URLs on /purchase/return, a page whose
 * only job is to hand back to the app. The webhook grants credits exactly as
 * for the web — nothing else changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TestD1, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';

const SITE = 'https://listinglab.test';
const here = dirname(fileURLToPath(import.meta.url));

function makeEnv(db, assetLog) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    ASSETS: { fetch: async (req) => { assetLog?.push(req.url); return new Response('<!doctype html>asset', { headers: { 'content-type': 'text/html' } }); } },
  };
}
const post = (path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});
async function signedUp(env, ctx) {
  const res = await worker.fetch(post('/api/signup', { email: 'agent@example.com', password: 'password-one-two' }), env, ctx);
  assert.equal(res.status, 201);
  return res.headers.get('set-cookie').split(';')[0];
}

/** Stand in for Stripe: record the Checkout session request, answer with a URL. */
function stubStripe() {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.stripe.com/')) {
      calls.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { headers: { 'content-type': 'application/json' } });
    }
    return real(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('the web gets the web return URLs; the app gets the hand-back page', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const cookie = await signedUp(env, ctx);
  const stripe = stubStripe();
  try {
    const web = await worker.fetch(post('/api/checkout', { packId: 'pack_30' }, { cookie }), env, ctx);
    assert.equal(web.status, 200);
    assert.equal((await web.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.equal(stripe.calls[0].get('success_url'), `${SITE}/app?purchase=success`);
    assert.equal(stripe.calls[0].get('cancel_url'), `${SITE}/app?purchase=cancelled`);

    const ios = await worker.fetch(post('/api/checkout', { packId: 'pack_30', platform: 'ios' }, { cookie }), env, ctx);
    assert.equal(ios.status, 200);
    assert.equal(stripe.calls[1].get('success_url'), `${SITE}/purchase/return?status=success`);
    assert.equal(stripe.calls[1].get('cancel_url'), `${SITE}/purchase/return?status=cancelled`);
    // Everything else about the purchase is identical: same pack, same price, same account.
    for (const k of ['mode', 'metadata[pack_id]', 'metadata[account_id]', 'line_items[0][price_data][unit_amount]', 'customer_email']) {
      assert.equal(stripe.calls[1].get(k), stripe.calls[0].get(k), k);
    }
    assert.equal(stripe.calls[1].get('line_items[0][price_data][unit_amount]'), '5699');

    // Any other platform value is the web.
    await worker.fetch(post('/api/checkout', { packId: 'pack_10', platform: 'android' }, { cookie }), env, ctx);
    assert.equal(stripe.calls[2].get('success_url'), `${SITE}/app?purchase=success`);
  } finally { stripe.restore(); }
  db.close();
});

test('/purchase/return serves the hand-back page with the status Stripe appended', async () => {
  const db = new TestD1(); const assets = []; const env = makeEnv(db, assets); const ctx = testCtx();
  const res = await worker.fetch(new Request(`${SITE}/purchase/return?status=success`), env, ctx);
  assert.equal(res.status, 200);
  assert.equal(assets[0], `${SITE}/purchase-return.html?status=success`);
  // No sign-in needed: Safari carries no app session, and the page holds nothing private.
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self' 'unsafe-inline'/, 'the inline hand-off script is allowed by the page CSP');
});

test('the hand-back page says the right thing and opens the app', () => {
  const html = readFileSync(join(here, '..', 'web', 'purchase-return.html'), 'utf8');
  assert.match(html, /Payment received — returning you to the app…/);
  assert.match(html, /No charge — returning you to the app…/);
  assert.match(html, /location\.href = target/);
  assert.match(html, /'listinglab:\/\/purchase\?status=' \+ status/);
  assert.match(html, />Open Listing Lab</);
  assert.match(html, /You can also just switch back to the app\./);
  assert.match(html, /name="robots" content="noindex"/);
  assert.ok(!/in-app purchase|App Store/i.test(html));
});
