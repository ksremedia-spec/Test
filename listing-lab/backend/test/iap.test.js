/**
 * Listing Lab — in-app purchase verification (the iOS app, 9 Sep 2026).
 *
 * Apple signs each App Store transaction with a certificate chain that ends
 * at Apple Root CA - G3. Nobody outside Apple can sign with that chain, so
 * these tests use a look-alike chain built by test/fixtures/apple-iap/
 * make-chain.sh (same shape, same algorithms, same Apple extension OIDs) and
 * hand its root to the verifier as the trust anchor. Every refusal below is
 * a real cryptographic or structural check, not a stubbed answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TestD1, TestR2, testCtx } from './helpers/d1.js';
import worker from '../src/worker.js';
import { Store } from '../src/store.js';
import {
  verifyAppStoreTransaction, parseCertificate, AppleVerificationError, APP_BUNDLE_ID, IAP_PRODUCTS,
} from '../src/apple.js';
import { CREDIT_PACKS } from '../src/ledger.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(join(here, 'fixtures', 'apple-iap', name), 'utf8');
/** PEM body → the base64 DER that goes into an x5c entry. */
const pemBody = pem => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
const derOf = pem => Uint8Array.from(atob(pemBody(pem)), c => c.charCodeAt(0));

const LEAF = fixture('leaf.pem'), INTERMEDIATE = fixture('intermediate.pem'), ROOT = fixture('root.pem');
const OTHER_ROOT = fixture('other-root.pem');
const ROOTS = [derOf(ROOT)];
// The fixture chain was minted when make-chain.sh last ran, so "now" is the clock.
const NOW = Date.now();

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = obj => b64url(enc.encode(JSON.stringify(obj)));

async function leafKey() {
  return crypto.subtle.importKey('pkcs8', derOf(fixture('leaf.pkcs8.pem')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** A transaction the way StoreKit 2 presents one (the fields the verifier reads, plus the usual company). */
const transaction = (over = {}) => ({
  transactionId: '2000000123456789',
  originalTransactionId: '2000000123456789',
  bundleId: APP_BUNDLE_ID,
  productId: 'com.horizonhomemedia.listinglab.credits10',
  purchaseDate: NOW - 5000,
  originalPurchaseDate: NOW - 5000,
  quantity: 1,
  type: 'Consumable',
  inAppOwnershipType: 'PURCHASED',
  signedDate: NOW - 4000,
  environment: 'Production',
  transactionReason: 'PURCHASE',
  storefront: 'USA',
  storefrontId: '143441',
  price: 19990,
  currency: 'USD',
  ...over,
});

/** Sign a transaction exactly as Apple does: ES256, chain in the header. */
async function signed(payload, { chain = [LEAF, INTERMEDIATE, ROOT], key = null, header = null } = {}) {
  const h = header || { alg: 'ES256', x5c: chain.map(pemBody) };
  const input = `${b64urlJson(h)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key || await leafKey(), enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const refuses = (fn, code) => assert.rejects(fn, err => {
  assert.ok(err instanceof AppleVerificationError, `expected AppleVerificationError, got ${err && err.name}: ${err && err.message}`);
  assert.equal(err.code, code, `expected ${code}, got ${err.code}`);
  return true;
});

/* ------------------------------------------------------------ the fixture */

test('the fixture chain has the shape of Apple\'s', () => {
  const leaf = parseCertificate(derOf(LEAF)), mid = parseCertificate(derOf(INTERMEDIATE)), root = parseCertificate(derOf(ROOT));
  assert.ok(leaf.extensionOids.includes('1.2.840.113635.100.6.11.1'), 'leaf carries the App Store signing marker');
  assert.ok(mid.extensionOids.includes('1.2.840.113635.100.6.2.1'), 'intermediate carries the WWDR marker');
  assert.equal(leaf.curve, '1.2.840.10045.3.1.7', 'P-256 leaf');
  assert.equal(root.curve, '1.3.132.0.34', 'P-384 root');
  assert.ok(root.notAfter > NOW, 'and it has not expired under the tests');
});

/* ----------------------------------------------------------- the verifier */

test('a transaction signed by the chain verifies and names the credits it bought', async () => {
  const out = await verifyAppStoreTransaction(await signed(transaction()), { roots: ROOTS, now: NOW });
  assert.equal(out.transactionId, '2000000123456789');
  assert.equal(out.credits, 10);
  assert.equal(out.packId, 'pack_10');
  assert.equal(out.environment, 'Production');
});

test('a chain that leads to a different root is not Apple', async () => {
  await refuses(() => signed(transaction()).then(j => verifyAppStoreTransaction(j, { roots: [derOf(OTHER_ROOT)], now: NOW })), 'IAP_UNTRUSTED_ROOT');
});

test('a chain that is missing a link is refused', async () => {
  await refuses(() => signed(transaction(), { chain: [LEAF, ROOT] }).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_CHAIN');
  await refuses(() => signed(transaction(), { chain: [LEAF] }).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_CHAIN');
  await refuses(() => signed(transaction(), { header: { alg: 'ES256', x5c: ['bm90IGEgY2VydA=='] } }).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_CHAIN');
});

test('a real chain with a signature from someone else\'s key is refused', async () => {
  // The attacker has Apple's public chain (it is in every transaction) but not the leaf's private key.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await refuses(() => signed(transaction(), { key: pair.privateKey }).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_SIGNATURE');
});

test('a tampered payload is refused — the 10-pack cannot become the 75-pack', async () => {
  const jws = await signed(transaction());
  const [h, , s] = jws.split('.');
  const tampered = `${h}.${b64urlJson(transaction({ productId: 'com.horizonhomemedia.listinglab.credits75' }))}.${s}`;
  await refuses(() => verifyAppStoreTransaction(tampered, { roots: ROOTS, now: NOW }), 'IAP_SIGNATURE');
});

test('the algorithm the token claims is not trusted', async () => {
  const bad = await signed(transaction(), { header: { alg: 'none', x5c: [LEAF, INTERMEDIATE, ROOT].map(pemBody) } });
  await refuses(() => verifyAppStoreTransaction(bad, { roots: ROOTS, now: NOW }), 'IAP_ALG');
});

test('the wrong app, an unknown product, a revoked purchase, a missing id', async () => {
  await refuses(() => signed(transaction({ bundleId: 'com.example.other' })).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_WRONG_APP');
  await refuses(() => signed(transaction({ productId: 'com.horizonhomemedia.listinglab.credits1000' })).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_UNKNOWN_PRODUCT');
  await refuses(() => signed(transaction({ revocationDate: NOW - 1000 })).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_REVOKED');
  await refuses(() => signed(transaction({ transactionId: undefined })).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW })), 'IAP_MALFORMED');
});

test('Sandbox is refused unless the owner has switched it on for testing', async () => {
  const sandbox = await signed(transaction({ environment: 'Sandbox' }));
  await refuses(() => verifyAppStoreTransaction(sandbox, { roots: ROOTS, now: NOW }), 'IAP_SANDBOX');
  const out = await verifyAppStoreTransaction(sandbox, { roots: ROOTS, now: NOW, allowSandbox: true });
  assert.equal(out.environment, 'Sandbox');
  // Xcode's local StoreKit environment is never accepted: it is not Apple's chain anyway.
  await refuses(() => signed(transaction({ environment: 'Xcode' })).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: NOW, allowSandbox: true })), 'IAP_SANDBOX');
});

test('certificates are checked against the clock', async () => {
  await refuses(() => signed(transaction()).then(j => verifyAppStoreTransaction(j, { roots: ROOTS, now: Date.parse('1999-01-01T00:00:00Z') })), 'IAP_CERT_EXPIRED');
});

test('with no root configured every purchase is refused — fail closed, never open', async () => {
  await refuses(() => signed(transaction()).then(j => verifyAppStoreTransaction(j, { roots: [], now: NOW })), 'IAP_ROOT_NOT_CONFIGURED');
  await refuses(() => signed(transaction()).then(j => verifyAppStoreTransaction(j, { roots: [new Uint8Array(0)], now: NOW })), 'IAP_ROOT_NOT_CONFIGURED');
});

test('garbage is a refusal, not a crash', async () => {
  for (const bad of ['', 'a.b', 'a.b.c', null, 7]) {
    await refuses(() => verifyAppStoreTransaction(bad, { roots: ROOTS, now: NOW }), 'IAP_MALFORMED');
  }
});

test('the three products match the three packs the ledger sells', () => {
  for (const [id, p] of Object.entries(IAP_PRODUCTS)) {
    const pack = CREDIT_PACKS.find(x => x.id === p.packId);
    assert.ok(pack, `${id} names a real pack`);
    assert.equal(pack.credits, p.credits, `${id} grants what ${p.packId} sells`);
    assert.ok(id.startsWith(APP_BUNDLE_ID + '.'), 'product ids live under the bundle id');
  }
});

/* --------------------------------------------------------------- the route */

const SITE = 'https://listinglab.test';
function makeEnv(db) {
  return {
    DB: db,
    SITE_URL: SITE,
    STRIPE_SECRET_KEY: 'sk_test_x',
    PHOTOS: new TestR2(),
    ASSETS: { fetch: async () => new Response('asset') },
    // The tests trust the fixture root in place of Apple's.
    IAP_TRUST_ROOT_BASE64: pemBody(ROOT),
  };
}
const post = (path, body, headers = {}) => new Request(`${SITE}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (path, headers = {}) => new Request(`${SITE}${path}`, { headers });
async function signedIn(env, ctx, email = 'agent@example.com') {
  const res = await worker.fetch(post('/api/signup', { email, password: 'password-one-two' }), env, ctx);
  const payload = await res.json();
  assert.equal(res.status, 201, JSON.stringify(payload));
  return { cookie: res.headers.get('set-cookie').split(';')[0], account: payload.account };
}
const creditsOf = async (env, ctx, cookie) => (await (await worker.fetch(get('/api/credits', { cookie }), env, ctx)).json());

test('a verified purchase lands the credits once; every replay is answered alreadyGranted', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await signedIn(env, ctx);
  const jws = await signed(transaction({ productId: 'com.horizonhomemedia.listinglab.credits30', transactionId: '2000000000000030' }));

  const first = await worker.fetch(post('/api/iap/verify', { signedTransaction: jws }, { cookie }), env, ctx);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, granted: 30, balance: 30, alreadyGranted: false });

  // The app replays unfinished transactions on every launch.
  for (let i = 0; i < 3; i++) {
    const again = await worker.fetch(post('/api/iap/verify', { signedTransaction: jws }, { cookie }), env, ctx);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, granted: 30, balance: 30, alreadyGranted: true });
  }
  const credits = await creditsOf(env, ctx, cookie);
  assert.equal(credits.balance, 30);
  assert.equal(credits.statement[0].description, 'Bought 30 credits', 'reads like a Stripe purchase on the statement');
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE key = 'iap:2000000000000030'").get().n, 1);
  db.close();
});

test('a transaction one account already used grants nothing to another account', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const a = await signedIn(env, ctx, 'a@example.com');
  const b = await signedIn(env, ctx, 'b@example.com');
  const jws = await signed(transaction());
  assert.equal((await worker.fetch(post('/api/iap/verify', { signedTransaction: jws }, { cookie: a.cookie }), env, ctx)).status, 200);
  const stolen = await worker.fetch(post('/api/iap/verify', { signedTransaction: jws }, { cookie: b.cookie }), env, ctx);
  assert.equal(stolen.status, 200);
  assert.deepEqual(await stolen.json(), { ok: true, granted: 10, balance: 0, alreadyGranted: true });
  assert.equal((await creditsOf(env, ctx, b.cookie)).balance, 0);
  assert.equal((await creditsOf(env, ctx, a.cookie)).balance, 10);
  db.close();
});

test('the route refuses what the verifier refuses, with a code the app can read', async () => {
  const db = new TestD1(); const env = makeEnv(db); const ctx = testCtx();
  const { cookie } = await signedIn(env, ctx);
  const wrongApp = await worker.fetch(post('/api/iap/verify', { signedTransaction: await signed(transaction({ bundleId: 'com.example.other' })) }, { cookie }), env, ctx);
  assert.equal(wrongApp.status, 400);
  assert.equal((await wrongApp.json()).error.code, 'IAP_WRONG_APP');
  const empty = await worker.fetch(post('/api/iap/verify', {}, { cookie }), env, ctx);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'IAP_TRANSACTION_REQUIRED');
  const anon = await worker.fetch(post('/api/iap/verify', { signedTransaction: await signed(transaction()) }), env, ctx);
  assert.equal(anon.status, 401);
  assert.equal((await creditsOf(env, ctx, cookie)).balance, 0);
  db.close();
});

test('IAP_ALLOW_SANDBOX gates sandbox purchases on the live route', async () => {
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db);
  const { cookie } = await signedIn(env, ctx);
  const jws = await signed(transaction({ environment: 'Sandbox', transactionId: '1000000000000001' }));
  const off = await worker.fetch(post('/api/iap/verify', { signedTransaction: jws }, { cookie }), env, ctx);
  assert.equal(off.status, 400);
  assert.equal((await off.json()).error.code, 'IAP_SANDBOX');
  const on = await worker.fetch(post('/api/iap/verify', { signedTransaction: jws }, { cookie }), { ...env, IAP_ALLOW_SANDBOX: '1' }, ctx);
  assert.equal(on.status, 200);
  assert.equal((await on.json()).balance, 10);
  db.close();
});

test('without the override the route trusts only the embedded Apple root', async () => {
  // src/apple-root.js may still be empty (see its comment) — then the route
  // fails closed with 503 and the app keeps the transaction to retry. Once
  // Apple's real root is embedded, the fixture chain is simply not Apple's.
  const db = new TestD1(); const ctx = testCtx();
  const env = makeEnv(db); delete env.IAP_TRUST_ROOT_BASE64;
  const { cookie } = await signedIn(env, ctx);
  const res = await worker.fetch(post('/api/iap/verify', { signedTransaction: await signed(transaction()) }, { cookie }), env, ctx);
  const out = await res.json();
  assert.ok(
    (res.status === 503 && out.error.code === 'IAP_ROOT_NOT_CONFIGURED') ||
    (res.status === 400 && out.error.code === 'IAP_UNTRUSTED_ROOT'),
    `got ${res.status} ${out.error?.code}`);
  assert.equal((await creditsOf(env, ctx, cookie)).balance, 0);
  db.close();
});
