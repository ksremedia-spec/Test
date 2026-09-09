# Golden set

A fixed exam for the compliance judge. `manifest.json` lists cases: an original photo, a
candidate output, the transformation (and room/style for staging), and the HUMAN-decided
expected verdict (`pass` = deliver to client, `fail` = reject and retry).

- `GRADE-ME.html` — open in a browser, review every case, correct any proposed verdict, click
  Export, paste the JSON into `grades.json`. Run `node golden-apply.js` to fold grades into the manifest.
- `node golden-run.js` — runs the judge over every case and prints a scorecard: overall score,
  per-type score, false rejects (good image failed), false accepts (bad image passed), and which
  cases BROKE or were FIXED since the previous run. Exit code 1 on any miss, so it can gate deploys.
- Run it after ANY change to prompts.js / compliance.js / layout.js / inventory.js / the judge model.

Grow it: whenever a customer job is rejected wrongly or a bad image slips through, add that pair
here with the correct verdict. The set should accumulate every mistake the system has ever made.
