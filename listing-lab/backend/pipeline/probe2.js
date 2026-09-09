const fs = require('fs');
for (const line of fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const sharp = require('sharp');
const { nanoBananaEdit, setDeadline } = require('./gemini.js');
const meter = require('./meter.js');
setDeadline(Date.now() + 170000);
(async () => {
  const px = await sharp({ create: { width: 512, height: 384, channels: 3, background: { r: 190, g: 175, b: 155 } } }).jpeg().toBuffer();
  const m = meter.setMeter(meter.newMeter());
  const t0 = Date.now();
  try {
    const r = await nanoBananaEdit(process.env.GEMINI_API_KEY, 'Return this image with no changes.',
      px.toString('base64'), 'image/jpeg', { imageSize: '1K' });
    console.log('IMAGE OK in', ((Date.now() - t0) / 1000).toFixed(1) + 's — bytes', (r.data || '').length);
  } catch (e) {
    console.log('IMAGE FAILED in', ((Date.now() - t0) / 1000).toFixed(1) + 's —', String(e.message).slice(0, 250));
  }
  const s = meter.summarise(m, { imageSize: '1K' });
  console.log('  calls:', JSON.stringify(s.doors), '| failed:', JSON.stringify(s.failedCalls).slice(0, 200));
})();
