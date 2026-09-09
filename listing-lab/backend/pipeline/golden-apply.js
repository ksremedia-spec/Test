// Fold exported grades (golden/grades.json) into golden/manifest.json
const fs = require('fs');
const man = JSON.parse(fs.readFileSync('golden/manifest.json')); const g = JSON.parse(fs.readFileSync('golden/grades.json'));
let changed = 0;
for (const c of man.cases) { const v = g[c.id]; if (!v) continue; if (v.verdict === 'skip') { c.expected = 'skip'; changed++; continue; } if (v.verdict !== c.expected) { c.expected = v.verdict; changed++; } if (v.why) c.note = v.why + ' — ' + c.note; c.gradedBy = 'kyle'; }
fs.writeFileSync('golden/manifest.json', JSON.stringify(man, null, 2)); console.log(`applied, ${changed} verdicts changed`);
