// Re-judge an existing candidate without regenerating (dev/test helper).
//   node judge-only.js --type declutter --original a.jpg --candidate b.jpg
const fs = require('fs');
const { judgeCompliance } = require('./compliance');
const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : undefined; };
const mime = f => /\.png$/i.test(f) ? 'image/png' : 'image/jpeg';
(async () => {
  const o = arg('original'), c = arg('candidate'), type = arg('type');
  const inv = arg('inventory') ? JSON.parse(fs.readFileSync(arg('inventory'),'utf8')).inventory : undefined;
  const v = await judgeCompliance(process.env.GEMINI_API_KEY, type,
    fs.readFileSync(o).toString('base64'), mime(o),
    fs.readFileSync(c).toString('base64'), mime(c),
    process.env.JUDGE_MODEL || 'gemini-3.6-flash', inv);
  console.log(JSON.stringify({ original: o, candidate: c, type, ...v }, null, 2));
})();
