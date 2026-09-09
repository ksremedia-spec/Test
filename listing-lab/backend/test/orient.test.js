/**
 * The upright step (3 Sep 2026): an iPhone portrait stored sideways with an
 * EXIF rotation tag must reach the model, the judge and the customer upright.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { uprightInput } = require('../pipeline/orient.js');

async function tallRoom() {
  // 300 wide x 400 tall picture: red top half, blue bottom half.
  const top = Buffer.alloc(300 * 200 * 3, 0); for (let i = 0; i < top.length; i += 3) top[i] = 255;
  const bottom = Buffer.alloc(300 * 200 * 3, 0); for (let i = 2; i < bottom.length; i += 3) bottom[i] = 255;
  return sharp(Buffer.concat([top, bottom]), { raw: { width: 300, height: 400, channels: 3 } }).jpeg().toBuffer();
}

test('a sideways iPhone portrait is turned upright, once, and the tag is dropped', async () => {
  const upright = await tallRoom();
  // Store it the way an iPhone does: pixels rotated 90° clockwise on disk, tag 6 says "rotate me".
  const sideways = await sharp(upright).rotate(-90).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const m0 = await sharp(sideways).metadata();
  assert.equal(m0.orientation, 6); assert.equal(m0.width, 400); assert.equal(m0.height, 300);

  const out = await uprightInput(sideways);
  assert.equal(out.oriented, true); assert.equal(out.orientation, 6);
  const m1 = await sharp(out.buf).metadata();
  assert.equal(m1.width, 300); assert.equal(m1.height, 400, 'portrait again');
  assert.equal(m1.orientation, undefined, 'no tag left to rotate it twice');
  // And it is the same picture: red on top.
  const { data } = await sharp(out.buf).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 200 && data[2] < 60, 'top-left pixel is red');
  const last = data.length - 3;
  assert.ok(data[last + 2] > 200 && data[last] < 60, 'bottom-right pixel is blue');

  // A normal photo passes through byte-for-byte.
  const same = await uprightInput(upright);
  assert.equal(same.oriented, false);
  assert.equal(same.buf, upright);
});
