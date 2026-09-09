const fs = require('fs');
for (const line of fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].trim();
}
const sharp = require('sharp');
const { nanoBananaEdit, setDeadline } = require('./gemini.js');
(async () => {
  const px = await sharp({ create:{width:512,height:384,channels:3,background:{r:190,g:175,b:155}} }).jpeg().toBuffer();
  const b64 = px.toString('base64');
  const trials = [
    ['gemini-3-pro-image', '1K'], ['gemini-3-pro-image', '2K'], ['gemini-3-pro-image', '4K'],
    ['gemini-3.1-flash-image', '2K'], ['gemini-2.5-flash-image', '1K'],
  ];
  for (const [model, size] of trials) {
    setDeadline(Date.now() + 75000);
    process.env.IMAGE_MODEL = model;
    const t0 = Date.now();
    try {
      const r = await nanoBananaEdit(process.env.GEMINI_API_KEY, 'Return this image unchanged.',
        b64, 'image/jpeg', { imageSize: size, model, retries: 0 });
      console.log(`  ${model} @ ${size}  OK  ${((Date.now()-t0)/1000).toFixed(1)}s  ${(r.data||'').length} bytes`);
    } catch (e) {
      const msg = String(e.message);
      const code = (msg.match(/Gemini (\d{3})/) || [])[1] || '?';
      const why = /high demand/.test(msg) ? 'high demand' :
                  /not found|not supported|NOT_FOUND/i.test(msg) ? 'model not available to this key' :
                  /quota|exhaust/i.test(msg) ? 'quota' : msg.slice(0, 70);
      console.log(`  ${model} @ ${size}  FAIL ${code}  ${((Date.now()-t0)/1000).toFixed(1)}s  — ${why}`);
    }
  }
})();
