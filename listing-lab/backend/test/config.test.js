/**
 * Listing Lab — deployment configuration checks.
 *
 * WHY THIS FILE EXISTS
 * On 25 Aug 2026 `wrangler.toml` was left pointing at `container/Dockerfile.sandbox`
 * — a file that only ever existed inside the machine doing the deploying, created
 * to work around that environment's TLS-inspecting proxy. When it was cleaned out
 * of the deliverable, the reference stayed behind and every wrangler command died:
 *
 *   The image "./container/Dockerfile.sandbox" does not appear to be a valid path
 *
 * Two faults, and the deletion was the smaller one. The real fault was that a
 * workaround for one machine was written into the project's shared configuration
 * at all, where it would have failed for Kyle the first time he deployed.
 *
 * These tests are cheap and they run with everything else, so the config can no
 * longer reference something that is not in the repository, and an environment
 * that is not his can no longer be the one the config describes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'wrangler.toml'), 'utf8');

/** Values of every quoted setting that names a path we control. */
function settings(name) {
  return [...raw.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, 'gm'))].map(m => m[1]);
}

test('every file wrangler.toml points at actually exists', () => {
  const referenced = [
    ...settings('main'),
    ...settings('directory'),
    // A container image is either a path we ship or a registry reference.
    ...settings('image').filter(v => v.startsWith('.') || v.startsWith('/')),
    ...settings('image_build_context'),
  ];
  // Two, not three: the container image became a registry reference (built and
  // pushed from the deploy environment, 28 Aug 2026), so only `main` and the
  // assets directory remain as local paths.
  assert.ok(referenced.length >= 2, 'expected main and assets directory');
  for (const p of referenced) {
    assert.ok(existsSync(join(root, p)), `wrangler.toml points at "${p}", which is not in this project`);
  }
});

test('the container image is the one that ships, not a machine-specific variant', () => {
  // The failure this prevents: a Dockerfile built for one developer's proxy,
  // wired into the shared config, which cannot work anywhere else.
  for (const img of settings('image')) {
    if (!img.startsWith('.') && !img.startsWith('/')) continue;
    assert.ok(!/sandbox|local|tmp|dev-only|scratch/i.test(img),
      `wrangler.toml deploys "${img}" — that name says it is specific to one machine`);
  }
});

test('nothing in the project carries a stray CA certificate', () => {
  // The sandbox workaround needed a certificate copied into the build context.
  // It must never travel with the project: it is useless to anyone else and it
  // makes the container trust something it should not.
  for (const f of ['sandbox-ca.crt', 'ca.crt', 'proxy-ca.crt']) {
    assert.ok(!existsSync(join(root, f)), `${f} should not be in this project`);
  }
});

test('the shipped Dockerfile installs fonts', () => {
  // Without them the disclosure watermark renders as empty boxes — see README.
  const df = readFileSync(join(root, 'container', 'Dockerfile'), 'utf8');
  assert.match(df, /fonts-liberation/, 'the container needs fonts or the disclosure is gibberish');
});

test('the shipped Dockerfile does not bake in a key or a certificate', () => {
  const df = readFileSync(join(root, 'container', 'Dockerfile'), 'utf8');
  assert.ok(!/COPY\s+.*\.crt/i.test(df), 'no certificate should be copied into the image');
  assert.ok(!/ENV\s+GEMINI_API_KEY\s*=/i.test(df), 'the Gemini key must never be baked into the image');
  assert.ok(!/COPY\s+.*\.env/i.test(df), '.env must never be copied into the image');
});

test('the container pool has room to run', () => {
  // A cap below the pool size does not slow jobs down, it stops them starting:
  // "Maximum number of running container instances exceeded", and the job hangs
  // on "queued" forever.
  const cap = Number((raw.match(/^\s*max_instances\s*=\s*(\d+)/m) || [])[1]);
  assert.ok(Number.isFinite(cap), 'max_instances must be set');
  assert.ok(cap >= 6, `max_instances is ${cap}; the pool needs 4 job slots plus classify plus headroom`);
});

test('the site URL is a real deployed address, not a placeholder', () => {
  const url = (raw.match(/^\s*SITE_URL\s*=\s*"([^"]+)"/m) || [])[1];
  assert.ok(url, 'SITE_URL must be set — the container callback and Stripe links are built from it');
  assert.match(url, /^https:\/\//, 'SITE_URL must be https');
  assert.ok(!/example\.|localhost|PASTE|TODO/i.test(url), `SITE_URL looks like a placeholder: ${url}`);
});

test('the photo picker is not locked to the camera', () => {
  // Kyle, 25 Aug 2026, from his phone: "it opens up the camera. No option to go
  // to the camera roll. Just locked in the camera. Big problem."
  //
  // `capture` reads like a hint to prefer the camera. On iOS it is a lock: the
  // photo library and Files vanish. Agents shoot a house and upload afterwards,
  // so the camera roll is the normal path.
  const html = readFileSync(join(root, 'web', 'app.html'), 'utf8');
  assert.ok(!/capture\s*=/.test(html),
    'a `capture` attribute on the file input locks iOS users into the camera');
  // HEIC joined the accept list on 31 Aug 2026 (iPhones shoot it by default);
  // it is converted to JPEG in the browser, so the pipeline still only ever
  // receives JPEG/PNG — toUploadable() is the gate that guarantees that.
  assert.match(html, /type="file"[^>]*accept="image\/jpeg,image\/png,image\/heic,image\/heif,\.heic,\.heif"/,
    'the picker should accept JPEG, PNG and iPhone HEIC');
  assert.match(html, /async function toUploadable/,
    'HEIC must be converted client-side before upload');
});

test('twilight offers one look, not a menu', () => {
  // Kyle, 25 Aug 2026: three moods "convoluted the whole workflow".
  const html = readFileSync(join(root, 'web', 'app.html'), 'utf8');
  // Look for the moods as CODE — quoted values that would populate a picker —
  // not as prose. The comment explaining why the picker went is allowed to name
  // them, and an earlier version of this test failed on exactly that.
  assert.ok(!/'Golden Hour'|"Golden Hour"|'Blue Hour'|"Blue Hour"/.test(html),
    'the twilight moods should no longer be offered as choices');
  assert.ok(!/>\s*Time of day\s*</.test(html), 'the "Time of day" label should be gone');
  assert.match(html, /TWILIGHT_STYLE = 'Dusk'/, 'twilight should send one fixed style');
});

test('each transformation gets progress steps that match its own work', () => {
  // Telling an agent we are "measuring the room — doors, windows" while
  // relighting a sky is untrue: the interior structural pass never runs on an
  // exterior. Since 5 Sep 2026 every transformation, twilight included, ends with the disclosure.
  const html = readFileSync(join(root, 'web', 'app.html'), 'utf8');
  for (const t of ['twilight', 'declutter', 'empty', 'staging']) {
    assert.ok(new RegExp(`\\b${t}:\\s*\\{\\s*secs`).test(html), `no progress plan for ${t}`);
  }
  const twilight = html.slice(html.indexOf('twilight: {'), html.indexOf('declutter: {'));
  assert.ok(!/Measuring the room/.test(twilight), 'twilight must not claim to measure a room');
  assert.match(twilight, /Applying the disclosure/, 'twilight is disclosed like every other transformation (5 Sep 2026)');
  assert.match(twilight, /Relighting the sky/);
});

test('the compare slider puts the original on the left and the result on the right', () => {
  // Kyle, 25 Aug 2026: "The slider is reversed on the finished product."
  //
  // The layer that is CLIPPED is the one the handle reveals, and it is anchored
  // to the left edge. So the clipped layer must be the ORIGINAL, sitting on top
  // of the result. Having the result be the clipped layer put the finished photo
  // on the left, which is backwards from every comparison an agent has ever seen
  // — and backwards from this view's own ORIGINAL / RESULT labels.
  // There are now TWO slider templates — the result screen's and the photo
  // viewer's (added 29 Aug) — and the invariant holds for each: the base layer
  // is the RESULT (the first <img>, before the clip), and the clipped layer
  // anchored left holds the ORIGINAL (an <img> inside .orig).
  const html = readFileSync(join(root, 'web', 'app.html'), 'utf8');
  const starts = [...html.matchAll(/<div class="ba"/g)].map(m => m.index);
  assert.ok(starts.length >= 2, 'both slider templates should be in the page');
  for (const open of starts) {
    const ba = html.slice(open, html.indexOf('</div>`', open));
    const clipped = ba.indexOf('class="orig"');
    assert.ok(clipped > -1, 'the clipped layer should be the original');
    const baseImg = ba.indexOf('<img');
    assert.ok(baseImg > -1 && baseImg < clipped,
      'the result must be the base layer, underneath the clipped original');
    assert.ok(ba.indexOf('<img', clipped) > clipped,
      'the original must sit inside the clipped layer');
  }
  assert.match(html, /class="tag l">ORIGINAL/, 'the left label is ORIGINAL');
  assert.match(html, /class="tag r">RESULT/, 'the right label is RESULT');
  assert.match(html, /orig\.style\.width = pct/,
    'dragging should size the original, not the result');
});

test('the pricing page quotes edit counts that match what edits actually cost', async () => {
  // Kyle, 30 Aug 2026: the pricing cards claimed "10 Declutter, Empty Room or
  // Twilight edits" on a 10-credit pack — but declutter and empty cost 2
  // credits, so a buyer would get 5, not 10. The card told them double.
  // This pins the page's arithmetic to the ledger's real cost table: every
  // transformation named in a "N ... edits" bullet must be divided by its
  // actual credit cost.
  const { TRANSFORMATION_COST } = await import('../src/ledger.js');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  assert.equal(TRANSFORMATION_COST.declutter, 2);
  assert.equal(TRANSFORMATION_COST.staging, 2);
  assert.equal(TRANSFORMATION_COST.empty, 2);
  assert.equal(TRANSFORMATION_COST.twilight, 1);
  assert.match(html, /credits\/2\)\} Declutter, Empty Room or Virtual Staging/,
    'the 2-credit transformations must be counted at credits ÷ 2');
  assert.match(html, /credits\/1\)\} Twilight/,
    'twilight must be counted at credits ÷ 1');
  assert.ok(!/credits\/1\)\} Declutter/.test(html),
    'declutter must never be advertised at 1 credit');
});

test("the app's api() helper serializes plain-object bodies itself", () => {
  // Beta, 30 Aug 2026: multi-photo batches silently failed to start. The batch
  // handler passed `body` as a plain object while every other call site
  // stringified; fetch coerced it to "[object Object]" and the server refused
  // every job. The fix moved serialization INTO api(), so a call site can no
  // longer get this wrong. This pins that guard in place.
  const html = readFileSync(join(root, 'web', 'app.html'), 'utf8');
  const api = html.slice(html.indexOf('async function api('), html.indexOf('const res = await fetch'));
  assert.match(api, /JSON\.stringify\(opts\.body\)/,
    'api() must serialize plain-object bodies before fetch sees them');
  assert.match(api, /instanceof FormData/,
    'FormData must pass through untouched — uploads depend on it');
});

test('the database id has been filled in', () => {
  const id = (raw.match(/^\s*database_id\s*=\s*"([^"]+)"/m) || [])[1];
  assert.ok(id && !/PASTE|TODO|xxx/i.test(id), 'database_id is still a placeholder');
});
