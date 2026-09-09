/**
 * Listing Lab — the Vertex adapter.
 *
 * WHY THIS FILE EXISTS
 * Moving to Vertex is not a URL change. The developer API we use today takes
 * `input` / `response_format` and answers with `steps[].content[]`; Vertex takes
 * `contents` / `generationConfig.responseModalities` and answers with
 * `candidates[].content.parts[].inlineData`. Same model, different envelope.
 *
 * None of this can be proved against the real service until Kyle's Google Cloud
 * project exists, so what these tests hold is everything that does NOT need the
 * network: the request we build, the reply we accept, the reply we refuse, and
 * the token exchange that replaces the gcloud CLI the container does not have.
 * When the credentials land, one live call is all that should be left to find out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const vertex = require(join(root, 'pipeline', 'vertex.js'));

const PIXEL = 'ZmFrZS1qcGVn';

test('the request carries the photo, the instruction and the size asked for', () => {
  const body = vertex.buildBody('Remove the clutter.', PIXEL, 'image/jpeg', { imageSize: '4K' });
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[0].parts[0].text, 'Remove the clutter.');
  const photo = body.contents[0].parts.at(-1).inlineData;
  assert.equal(photo.data, PIXEL);
  assert.equal(photo.mimeType, 'image/jpeg');
  assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal(body.generationConfig.imageConfig.imageSize, '4K',
    'this is how 1K/2K/4K is asked for here — the other API spells it response_format');
});

test('reference images go BEFORE the photo being edited', () => {
  // Twilight shows the model a real day/dusk pair from Kyle's own shoot as a
  // worked example. If the working photo is not last, the model can return the
  // reference instead of the property.
  const body = vertex.buildBody('Relight it.', PIXEL, 'image/jpeg', {
    references: [{ label: 'EXAMPLE — daytime:', data: 'AAA', mime_type: 'image/jpeg' }],
  });
  const texts = body.contents[0].parts.map(p => p.text).filter(Boolean);
  assert.match(texts.at(-1), /NOW THE PHOTO TO EDIT/);
  assert.equal(body.contents[0].parts.at(-1).inlineData.data, PIXEL, 'the working photo is last');
  assert.equal(body.contents[0].parts[2].inlineData.data, 'AAA', 'the reference came first');
});

test('the image is read out of Vertex\'s reply shape', () => {
  const out = vertex.imageFromResponse({
    candidates: [{ content: { parts: [
      { text: 'Here is the edited image.' },
      { inlineData: { mimeType: 'image/jpeg', data: PIXEL } },
    ] } }],
  });
  assert.deepEqual(out, { data: PIXEL, mime_type: 'image/jpeg' });
});

test('snake_case from the REST API is read too', () => {
  // The SDKs return inlineData; raw REST has been seen returning inline_data.
  // Reading only one spelling is a bug that looks exactly like an outage.
  const out = vertex.imageFromResponse({
    candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PIXEL } }] } }],
  });
  assert.deepEqual(out, { data: PIXEL, mime_type: 'image/png' });
});

test('a reply with no image is an error, never an empty success', () => {
  // A refusal comes back as a perfectly valid 200 with prose in it. Treating that
  // as a result would deliver an unedited photograph with a disclosure on it.
  assert.throws(
    () => vertex.imageFromResponse({ candidates: [{ content: { parts: [{ text: 'I cannot edit that.' }] } }] }),
    /No image in Vertex response: I cannot edit that/);
  assert.throws(() => vertex.imageFromResponse({}), /No image in Vertex response/);
});

test('express mode and a service account go to different addresses', () => {
  process.env.VERTEX_PROJECT = 'listinglab-prod';
  assert.match(vertex.endpoint('api_key'), /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\//);
  const sa = vertex.endpoint('service_account');
  assert.match(sa, /^https:\/\/[a-z0-9-]+-aiplatform\.googleapis\.com\//, 'regional endpoint');
  assert.match(sa, /\/projects\/listinglab-prod\/locations\//);
  delete process.env.VERTEX_PROJECT;
});

test('a service account call needs a project, and says so', () => {
  delete process.env.VERTEX_PROJECT;
  assert.throws(() => vertex.endpoint('service_account'), /VERTEX_PROJECT must be set/);
});

test('an access token is minted from the key file, without gcloud', async () => {
  // The container has no gcloud and should not grow one. Sign a JWT, swap it.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.VERTEX_SA_JSON = JSON.stringify({
    client_email: 'pipeline@listinglab.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  vertex.resetAuth();

  let sawBody = null, calls = 0;
  const fakeFetch = async (url, init) => {
    calls++; sawBody = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }), { status: 200 });
  };

  const now = 1_700_000_000_000;
  const token = await vertex.accessToken(now, fakeFetch);
  assert.equal(token, 'ya29.fake');
  assert.equal(sawBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims] = sawBody.get('assertion').split('.');
  const decoded = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(decoded.iss, 'pipeline@listinglab.iam.gserviceaccount.com');
  assert.match(decoded.scope, /cloud-platform/);
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');

  // Cached: a token per generation would add a round trip to every job.
  await vertex.accessToken(now + 60_000, fakeFetch);
  assert.equal(calls, 1, 'the token should be reused until it is nearly expired');
  // And refreshed before it actually expires, not after.
  await vertex.accessToken(now + 3_600_000, fakeFetch);
  assert.equal(calls, 2);

  vertex.resetAuth();
  delete process.env.VERTEX_SA_JSON;
});

test('a failed generation reports what Vertex said', async () => {
  const fakeFetch = async () => new Response('{"error":{"code":429,"message":"quota"}}', { status: 429 });
  await assert.rejects(
    () => vertex.vertexEdit(null, 'p', PIXEL, 'image/jpeg', {},
      { fetch: fakeFetch, mode: 'api_key', endpoint: 'https://example.test/x' }),
    /Vertex 429: .*quota/);
});

test('a whole call comes back in the shape the pipeline already expects', async () => {
  // Same return as nanoBananaEdit — {data, mime_type} — so nothing downstream
  // needs to know which provider drew the picture.
  process.env.VERTEX_API_KEY = 'express-key';
  const fakeFetch = async (url, init) => {
    assert.equal(init.headers['x-goog-api-key'], 'express-key');
    assert.equal(JSON.parse(init.body).generationConfig.imageConfig.imageSize, '2K');
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: PIXEL } }] } }],
    }), { status: 200 });
  };
  const out = await vertex.vertexEdit(null, 'Remove the clutter.', PIXEL, 'image/jpeg', { imageSize: '2K' },
    { fetch: fakeFetch, mode: 'api_key', endpoint: 'https://example.test/x' });
  assert.deepEqual(out, { data: PIXEL, mime_type: 'image/jpeg' });
  delete process.env.VERTEX_API_KEY;
});

test('with nothing configured it refuses rather than guessing', async () => {
  const saved = [process.env.VERTEX_API_KEY, process.env.VERTEX_SA_JSON];
  delete process.env.VERTEX_API_KEY; delete process.env.VERTEX_SA_JSON;
  await assert.rejects(() => vertex.vertexEdit(null, 'p', PIXEL, 'image/jpeg'),
    /Vertex is not configured/);
  if (saved[0]) process.env.VERTEX_API_KEY = saved[0];
  if (saved[1]) process.env.VERTEX_SA_JSON = saved[1];
});

test('the pipeline routes generations through the switch, not around it', () => {
  // A blanket rename while wiring this in made the helper call itself — infinite
  // recursion that `node --check` is perfectly happy with. Same shape as the
  // refund rename in Round 24: the replace looked right and changed one thing too
  // many. So: every generation goes through generateImage, generateImage itself
  // calls the real client, and no generation site calls a provider directly.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const helper = src.slice(src.indexOf('async function generateImage'), src.indexOf('const { judgeComplianceVoted'));
  assert.ok(!/generateImage\(/.test(helper.slice(helper.indexOf('{'))), 'generateImage must not call itself');
  // The doors are reached through injectable refs (for testing the model
  // fallback offline) that DEFAULT to the real clients — injection can only add
  // a fake in a test, never remove the real door. That default is the guarantee.
  assert.match(helper, /_doors\.nano \|\| nanoBananaEdit/, 'the developer API is the default developer-door client');
  assert.match(helper, /_doors\.vertex \|\| vertexEdit/, 'and Vertex is the default other door');
  assert.match(helper, /nano\(apiKey, prompt, imageB64, mime,/, 'the developer door is actually called');
  assert.match(helper, /vertex\(apiKey, prompt, imageB64, mime,/, 'and so is Vertex');
  assert.match(helper, /PROVIDER === 'vertex'/, 'which one is tried first is chosen deliberately');

  const body = src.slice(src.indexOf('async function main'));
  assert.ok(!/await nanoBananaEdit\(/.test(body), 'no generation site may bypass the switch');
  assert.ok(!/await vertexEdit\(/.test(body), 'nor call Vertex directly');
  assert.ok((body.match(/await generateImage\(/g) || []).length >= 3,
    'every generation — overcast, staging candidate and main attempt — goes through it');
});

test('switching provider is deliberate, never inferred', () => {
  // A half-set environment variable must not quietly reroute a paying customer's
  // job to a provider nobody has run a real photo through yet.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /PROVIDER \|\| 'gemini'/, 'the default stays where it is');
  assert.match(src, /PROVIDER=vertex but no Vertex credentials are set/,
    'asking for Vertex without credentials must fail loudly, not fall back');
});

test('a jammed door falls back to the other one', async () => {
  // The whole answer to "we can't be giving that error to a client". Measured on
  // 26 Aug 2026: the developer API returned 500 "currently experiencing high
  // demand" for over an hour while the identical prompt through Vertex came back
  // 200 with a picture in it. Same model, separate capacity pool.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const helper = src.slice(src.indexOf('async function generateImage'), src.indexOf('const { judgeComplianceVoted'));
  assert.match(helper, /DOOR_JAMMED\.test/, 'the fallback is triggered by a capacity failure');
  assert.match(helper, /return await secondary\(\)|const out = await secondary\(\)/, 'and it actually tries the other door');
  assert.match(helper, /bothDoorsShut/, 'with both failures reported when neither works');
  assert.match(helper, /retries: 1/, 'and it does not sit through the full retry budget first');
});

test('only a jammed door falls back — a bad request must not be paid for twice', () => {
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const m = src.match(/const DOOR_JAMMED = (\/.*\/i);/);
  assert.ok(m, 'the pattern should be findable');
  const re = new RegExp(m[1].slice(1, -2), 'i');
  for (const jammed of [
    'Gemini 500: {"error":{"message":"gemini-3-pro-image is currently experiencing high demand"}}',
    'Gemini 503: UNAVAILABLE',
    'Gemini 429: quota',
    'Gemini request timed out after 180s',
  ]) assert.ok(re.test(jammed), `should retry elsewhere: ${jammed.slice(0, 50)}`);
  for (const ours of [
    'Gemini 400: {"error":{"message":"Invalid argument"}}',
    'No image in response: {"steps":[]}',
  ]) assert.ok(!re.test(ours), `must NOT spend a second generation on: ${ours.slice(0, 50)}`);
});

test('a rate limit is waited out, not given up on', async () => {
  // Express mode caps requests per minute. Four concurrent jobs tripped it on
  // 26 Aug 2026 and every one of them failed — while the identical request from
  // the identical key answered 200 a minute later. A 429 here is OUR limit, not
  // Google's capacity, and it is the most recoverable failure in the system.
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    return calls < 3
      ? new Response('{"error":{"code":429,"message":"Resource exhausted."}}', { status: 429 })
      : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: PIXEL } }] } }] }), { status: 200 });
  };
  const out = await vertex.vertexEdit(null, 'p', PIXEL, 'image/jpeg', {},
    { fetch: fakeFetch, mode: 'api_key', endpoint: 'https://example.test/x' });
  assert.deepEqual(out, { data: PIXEL, mime_type: 'image/jpeg' });
  assert.equal(calls, 3, 'it waited the limit out instead of failing the job');
});

test('a request that is simply wrong is not retried four times', async () => {
  // A 400 will be a 400 again. Retrying it spends the customer's wall clock on
  // an answer that cannot change.
  let calls = 0;
  const fakeFetch = async () => { calls++; return new Response('{"error":{"code":400,"message":"Invalid argument"}}', { status: 400 }); };
  await assert.rejects(
    () => vertex.vertexEdit(null, 'p', PIXEL, 'image/jpeg', {}, { fetch: fakeFetch, mode: 'api_key', endpoint: 'https://example.test/x' }),
    /Vertex 400/);
  assert.equal(calls, 1);
});

test('the retry budget here is overridable too, for the fast-fallback shortcut', async () => {
  // generateImage knocks twice and moves on while the other door might be open.
  // The full budget comes back once that one has also refused.
  let calls = 0;
  const fakeFetch = async () => { calls++; return new Response('{"error":{"code":503}}', { status: 503 }); };
  await assert.rejects(
    () => vertex.vertexEdit(null, 'p', PIXEL, 'image/jpeg', { retries: 1 },
      { fetch: fakeFetch, mode: 'api_key', endpoint: 'https://example.test/x' }),
    /Vertex 503/);
  assert.equal(calls, 2);
});

test('when both doors refuse, the first is knocked at properly before giving up', () => {
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const helper = src.slice(src.indexOf('async function generateImage'), src.indexOf('const { judgeComplianceVoted'));
  assert.match(helper, /primaryPatient/, 'the shortcut is only a shortcut while it is paying for itself');
  assert.match(helper, /bothDoorsShut/);
  // And the patient call must NOT carry the shortened budget.
  const patient = helper.slice(helper.indexOf('const primaryPatient'), helper.indexOf('const secondary'));
  assert.ok(!/retries: 1/.test(patient), 'patience means the full budget, not the shortened one');
});

test('the working door becomes the first door, without a config change', () => {
  // 26 Aug 2026, within one hour: the developer API was dead for five hours so
  // Vertex was made the primary — and then Vertex's image pool exhausted while
  // the developer API recovered. A hardcoded order means every generation after
  // that knocks at the dead door first, burns two knocks, and falls through.
  // Right answer, slowest route to it, and a deploy needed every time the
  // weather turns. Both are shared pools; which is healthy is a fact about right
  // now, not about the deployment.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /let preferVertex = PROVIDER === 'vertex'/,
    'PROVIDER says where to START, not where to stay');
  const helper = src.slice(src.indexOf('async function generateImage'), src.indexOf('const { judgeComplianceVoted'));
  assert.match(helper, /const wantsVertex = preferVertex/, 'the live preference decides, not the env var');
  assert.match(helper, /preferVertex = !wantsVertex/, 'and a successful fallback moves it');

  // The credential check must still be against the CONFIGURED provider — a
  // learned preference must never be able to demand credentials nobody set.
  assert.match(helper, /PROVIDER === 'vertex' && !vertexAuthMode\(\)/,
    'asking for Vertex without credentials still fails loudly');
});

test('a model-level fallback exists, and it is not the same thing as the door failover', () => {
  // The two doors reach ONE model; when that model is overloaded (500 "high
  // demand") both doors fail identically and door failover cannot help. The
  // model-level fallback is the missing rung — added 27 Aug 2026 after a ~5h
  // gemini-3-pro-image outage. These invariants keep it correct.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const gi = src.slice(src.indexOf('async function generateImage'), src.indexOf('async function generateViaDoors'));

  assert.match(gi, /FALLBACK_MODEL/, 'generateImage must be able to switch models');
  assert.match(gi, /generateViaDoors\(/, 'it runs the door dance, and does so through the extracted helper');
  assert.ok(!/generateImage\(/.test(gi.slice(gi.indexOf('{'))), 'generateImage must not call itself');
  // A model pin disables it — an explicit choice is not a default to fall away from.
  assert.match(gi, /IMAGE_MODEL \|\| primaryModel === FALLBACK_MODEL/, 'pinned model or already-fallback must not fall back');
  // Never onto itself.
  assert.match(gi, /primaryModel === FALLBACK_MODEL/);
});

test('the model-down signal covers capacity AND a saturated rate limit', () => {
  // POLICY REVERSED 31 Aug 2026. A 429 was excluded on the theory that our
  // per-minute cap "clears in under a minute" — disproven in beta: parallel
  // testers kept the pro quota saturated continuously and two declutters sat
  // "working" for over an hour while flash never engaged. By the time
  // generateImage sees the error, both doors have already retried through the
  // 429 — so it counts, and the job falls to flash's separate quota.
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('const MODEL_DOWN'));
  assert.ok(line, 'MODEL_DOWN must be defined');
  assert.match(line, /429/, 'a saturated rate limit counts as the model being unreachable');
  assert.match(line, /high demand|500|503/, 'capacity signals still count');
});

test('the fallback model gets wider colour limits, keyed to the model that actually drew the image', () => {
  const src = readFileSync(join(root, 'pipeline', 'transform.js'), 'utf8');
  assert.match(src, /gen\.model === FALLBACK_MODEL \|\| gen\.model === 'flux-2-pro'\) \? FALLBACK_COLOUR/,
    'flash and storm-mode FLUX get wider limits, pro keeps the default');
  assert.match(src, /const FALLBACK_COLOUR = \{/, 'the wider limits are defined');
});
