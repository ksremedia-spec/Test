const fs = require('fs');
const { judgeComplianceVoted } = require('./compliance');
const b64 = f => fs.readFileSync(f).toString('base64');
(async () => {
  const cases = [
    ['Primary Bedroom', 'out/living.staging-Modern-HomeOffice.approved.jpg', 'office image, customer asked for BEDROOM'],
    ['Home Office', 'out/living.staging-Coastal-PrimaryBedroom.attempt2.raw.jpg', 'bedroom image, customer asked for OFFICE'],
    ['Home Office', 'out/living.staging-Modern-HomeOffice.approved.jpg', 'control: office image, customer asked for OFFICE'],
  ];
  for (const [room, file, label] of cases) {
    const layout = JSON.parse(fs.readFileSync('out/living.staging-Modern-HomeOffice.audit.json')).layout;
    layout.roomType = room;
    const v = await judgeComplianceVoted(process.env.GEMINI_API_KEY, 'staging', b64('living.jpg'), 'image/jpeg', b64(file), 'image/jpeg', 'gemini-3.6-flash', layout, 3);
    console.log(`\n${label}\n  → ${v.pass ? 'PASS' : 'FAIL'} (${v.passes}/${v.votes} pass)`);
    v.individual.forEach((r, i) => { const c = r.checks.staged_as_requested_room_type; console.log(`  vote ${i + 1} room-type check: ${c.ok ? 'ok' : 'FAILED'} — ${c.evidence.slice(0, 130)}`); });
    const rt = v.violations.filter(x => /room|bed|office|desk/i.test(x)); if (rt.length) console.log('  major: ' + rt[0]);
  }
})();
