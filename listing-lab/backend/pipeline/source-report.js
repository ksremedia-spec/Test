// Compare candidate sources (nano vs vsai) across all staging audit records in out/.
//   node source-report.js
const fs = require('fs'), path = require('path');
const files = fs.readdirSync('out').filter(f => f.endsWith('.audit.json')).map(f => path.join('out', f));
const stat = {};
for (const f of files) {
  const a = JSON.parse(fs.readFileSync(f)); if (a.type !== 'staging') continue;
  const scores = a.ranking?.scores || {}; const order = a.ranking?.order || [];
  for (const at of a.attempts) {
    const s = at.source || 'nano'; stat[s] ??= { candidates: 0, compliant: 0, delivered: 0, scoreSum: 0, scored: 0, errors: 0 };
    stat[s].candidates++; if (at.error) stat[s].errors++;
    if (at.verdict?.pass) stat[s].compliant++;
    const idx = order.indexOf(at.candidate); if (idx > -1 && scores[idx] !== undefined) { stat[s].scoreSum += scores[idx]; stat[s].scored++; }
    if (a.deliveredCandidate === at.candidate) stat[s].delivered++;
  }
}
console.log('source     candidates  compliant   delivered  avg design score  errors');
for (const [s, v] of Object.entries(stat)) console.log(`${s.padEnd(10)} ${String(v.candidates).padStart(10)}  ${String(v.compliant).padStart(9)} (${Math.round(100 * v.compliant / v.candidates)}%)  ${String(v.delivered).padStart(9)}  ${v.scored ? (v.scoreSum / v.scored).toFixed(1).padStart(16) : '               —'}  ${v.errors}`);
