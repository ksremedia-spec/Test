// read .env by hand — dotenv lives in the backend's node_modules, not here
const fs = require('fs');
for (const line of fs.readFileSync(__dirname + '/.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const { geminiGenerateContent, setDeadline } = require('./gemini.js');
setDeadline(Date.now() + 60000);
const t0 = Date.now();
geminiGenerateContent(process.env.GEMINI_API_KEY, 'gemini-3.6-flash',
  { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }] })
  .then(r => console.log('FLASH OK in', ((Date.now()-t0)/1000).toFixed(1)+'s'))
  .catch(e => console.log('FLASH FAILED in', ((Date.now()-t0)/1000).toFixed(1)+'s —', String(e.message).slice(0,220)));
