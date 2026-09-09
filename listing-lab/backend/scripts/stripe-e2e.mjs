/**
 * Listing Lab — Stripe end-to-end proof, ready to fire the moment the key
 * arrives. Run with the TEST key first:
 *
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-e2e.mjs
 *
 * What it does, in order:
 *   1. Registers the webhook endpoint with Stripe (idempotent — reuses an
 *      existing one for our URL) and prints the whsec_ signing secret.
 *   2. Reminds you to `wrangler secret put` both secrets and redeploy.
 *   3. With --purchase: signs into the live app with the test account, starts
 *      a real checkout for the 10-pack, drives Stripe's hosted page with the
 *      4242 test card in a headless browser, and watches the credit balance
 *      until the webhook lands the grant.
 *
 * Nothing here touches live money until you swap in sk_live_.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const KEY = process.env.STRIPE_SECRET_KEY;
const SITE = process.env.SITE_URL || 'https://listinglab.ksremedia.workers.dev';
const WEBHOOK_URL = `${SITE}/api/stripe/webhook`;
if (!KEY) { console.error('Set STRIPE_SECRET_KEY (sk_test_ first).'); process.exit(1); }

const stripe = async (path, form) => {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${KEY}`, ...(form && { 'content-type': 'application/x-www-form-urlencoded' }) },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error?.message}`);
  return json;
};

// ---- 1. webhook endpoint (idempotent) --------------------------------------
const existing = (await stripe('webhook_endpoints?limit=100')).data.find(w => w.url === WEBHOOK_URL);
let endpoint = existing;
if (!existing) {
  const form = new URLSearchParams();
  form.set('url', WEBHOOK_URL);
  form.set('enabled_events[0]', 'checkout.session.completed');
  form.set('description', 'Listing Lab credit grants');
  endpoint = await stripe('webhook_endpoints', form);
  console.log('Webhook endpoint CREATED:', endpoint.id);
  console.log('Signing secret (shown once by Stripe):', endpoint.secret);
} else {
  console.log('Webhook endpoint already registered:', endpoint.id, '(secret was shown at creation; roll it in the dashboard if lost)');
}
console.log(`\nNow set the Worker secrets and redeploy:
  npx wrangler secret put STRIPE_SECRET_KEY      # paste ${KEY.slice(0, 11)}…
  npx wrangler secret put STRIPE_WEBHOOK_SECRET  # paste the whsec_ value above
`);

// ---- 2. optional full purchase drive ---------------------------------------
if (!process.argv.includes('--purchase')) { console.log('Re-run with --purchase after the secrets are set to drive a full test buy.'); process.exit(0); }
if (!KEY.startsWith('sk_test_')) { console.error('Refusing --purchase with a LIVE key. Use sk_test_.'); process.exit(1); }

const email = readFileSync('/home/claude/golden/.acct_email', 'utf8').trim();
const password = readFileSync('/home/claude/golden/.acct_pw', 'utf8').trim();

// The sandbox routes all egress through a local TLS-inspecting proxy; Chromium
// needs to be pointed at it explicitly and told to trust its certificate.
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const p = await ctx.newPage();
await p.goto(`${SITE}/app`, { waitUntil: 'load' });
await p.fill('#email', email);
await p.fill('#password', password);
await p.click('#authBtn');
await p.waitForSelector('#creditChip:not(.hidden)', { timeout: 20000 });
const before = await p.$eval('#creditChip', e => parseInt(e.textContent) || 0);
console.log('signed in; balance before:', before);
await p.click('#creditChip');
await p.waitForSelector('#packList .pack', { timeout: 15000 });
await p.click('#packList .pack');                       // 10-pack
await p.waitForURL(/checkout\.stripe\.com/, { timeout: 30000 });
console.log('on Stripe Checkout — paying with 4242 test card…');
await p.fill('input[name="cardNumber"]', '4242 4242 4242 4242');
await p.fill('input[name="cardExpiry"]', '12 / 30');
await p.fill('input[name="cardCvc"]', '123');
const nameField = await p.$('input[name="billingName"]');
if (nameField) await nameField.fill('Kyle Test');
const zip = await p.$('input[name="billingPostalCode"]');
if (zip) await zip.fill('01001');
await p.click('button[type="submit"], .SubmitButton');
await p.waitForURL(u => String(u).includes('purchase=success'), { timeout: 45000 });
console.log('redirected back with purchase=success — waiting for the webhook grant…');
let after = before;
for (let i = 0; i < 15 && after < before + 10; i++) {
  await p.waitForTimeout(2000);
  after = await p.evaluate(async () => (await (await fetch('/api/credits')).json()).balance);
}
console.log(after >= before + 10
  ? `PASS — balance ${before} → ${after}: checkout, webhook, and grant all work.`
  : `FAIL — balance still ${after}; check the webhook secret and worker logs.`);
await b.close();
