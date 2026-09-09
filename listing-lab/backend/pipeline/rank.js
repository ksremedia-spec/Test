/**
 * Listing Lab — head-stager ranking. Given 2+ COMPLIANT candidates for the
 * same room, one vision call ranks them the way a senior stager would choose
 * which to send to the client. Compliance is already settled by the judge;
 * this is purely design quality.
 */
const { geminiGenerateContent } = require('./gemini');

async function rankCandidates(apiKey, model, originalB64, mime, candidates, roomType, style) {

  const parts = [{ text: `You are the head stager at a luxury real-estate photography studio choosing which virtually staged version of this ${roomType} (${style} style) to deliver. Image 0 is the empty original. Images 1..${candidates.length} are compliant candidates (structure and rules already verified — do not re-check those).
Judge ONLY design quality, as a client would see it, IN THIS PRIORITY ORDER — a lower criterion never outweighs a higher one: (1) ARRANGEMENT — the main seating faces the room's focal point (fireplace/TV/view) and the group reads as a true conversation area with good traffic flow and correct scale; a sofa that runs parallel to a window wall facing across the room loses to one that faces the fireplace, regardless of palette; (2) realism — contact shadows, reflections on the floor, fabric and wood texture, lighting matching the room; (3) taste — cohesive palette with the wall colour and flooring, restraint, nothing gimmicky; (4) would this make a buyer want to see the home.
Also give each candidate a DESIGN SCORE 1–10 as a stager would (10 = send to a luxury client as-is; 7 = good, deliverable; 5 = mediocre, a client would likely complain; 3 = bad placement or obviously fake). Be strict on placement: seating with its back to the focal point, chairs facing empty floor, pieces crammed into a corner or floating pointlessly score 4 or below.\nRespond with ONLY JSON: {"ranking":[best candidate number, next, ...], "scores":{"1":7,"2":4}, "reasons":{"1":"one sentence", "2":"..."}}` },
    { text: 'Image 0 — original:' }, { inline_data: { mime_type: mime, data: originalB64 } }];
  candidates.forEach((c, i) => { parts.push({ text: `Image ${i + 1}:` }); parts.push({ inline_data: { mime_type: c.mime_type || 'image/jpeg', data: c.data } }); });
  const json = await geminiGenerateContent(apiKey, model, { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, response_mime_type: 'application/json' } });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try {
    const v = JSON.parse(text);
    const order = (v.ranking || []).map(n => n - 1).filter(i => i >= 0 && i < candidates.length);
    candidates.forEach((_, i) => { if (!order.includes(i)) order.push(i); });
    const scores = {}; for (const [k, val] of Object.entries(v.scores || {})) scores[Number(k) - 1] = Number(val);
    return { order, reasons: v.reasons || {}, scores };
  } catch { return { order: candidates.map((_, i) => i), reasons: { parseError: text.slice(0, 200) } }; }
}

/**
 * Design/quality score for ONE candidate (staging or twilight), 1–10, same scale
 * as the ranking call. Used as the delivery gate (MIN_DESIGN_SCORE) and by the
 * golden-set runner so the test exercises the full ship/no-ship decision.
 */
/** Calibration examples for the staging scorer: Kyle-graded pass/fail pairs from golden/.
 * Shown to the REVIEWER only (never the generator). Excludes the case being scored. */
function calibrationExamples(type, excludeCandidatePath) {
  try {
    const fs = require('fs'), path = require('path');
    const man = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden/manifest.json')));
    const graded = man.cases.filter(c => c.type === type && c.gradedBy && c.calibration && c.candidate !== excludeCandidatePath);
    const pick = (exp, n) => graded.filter(c => c.expected === exp).slice(0, n);
    return [...pick('pass', 2), ...pick('fail', 2)].map(c => ({ expected: c.expected, why: (c.note || '').split(' — ')[0].slice(0, 80), data: fs.readFileSync(path.join(__dirname, c.candidate)).toString('base64') }));
  } catch { return []; }
}

async function scoreCandidate(apiKey, model, originalB64, mime, candidate, type, roomType, style, excludePath) {
  const rubric = type === 'twilight'
    ? `You are the head photographer at a luxury real-estate studio reviewing a day-to-twilight conversion before it goes to the client. Image 0 is the daytime original, Image 1 the conversion. Score 1–10. The studio's standard, learned from graded examples: a GOOD twilight (7–10) is BRIGHT and crisp — a pink-orange-to-blue sunset sky with visible cloud detail, the house and lawn clearly lit and legible with natural colour, warm window glow, clean edges. A BAD twilight (≤4) is dark or moody: deep violet/purple cast, an underexposed or muddy lawn, the house sinking into the dark, a cartoonish or banded sky, halos, or windows that look painted on. Also score ≤3 if the camera angle, framing, or perspective differs from Image 0 at all (e.g. the house appears straight-on when the original is angled).
First compare framing and perspective with Image 0, then describe the exposure of the lawn and house, then score.`
        : `You are the head stager at a luxury real-estate studio reviewing a virtually staged ${roomType} (${style}). Image 0 is the empty original, Image 1 the staged candidate (compliance already verified — judge ONLY design quality). Score 1–10. The studio's standard, learned from graded examples:
GOOD (7–10): the main grouping sits CENTERED in the room's open floor with the rug under it and comfortable, even spacing; the room looks fully and confidently furnished (sofa + chairs + tables + lamp + art), balanced left-to-right, with breathing room to walls and openings; pieces face each other as a conversation group; scale matches the room; shadows and reflections convincing. A sofa running parallel to a window wall is FINE when the grouping is centered and balanced.
BAD (≤4): furniture pushed up against the window wall or crammed into one side of a large room with the rest empty; a sparse room (a lone sofa and one chair in a big space); chairs or sofas with their backs to the camera dominating the foreground; pieces floating with no relation to each other; unbalanced composition; out-of-scale or obviously fake pieces.
Describe where the grouping sits in the frame and how balanced it is, then score.`;
  const examples = type === 'staging' ? calibrationExamples(type, excludePath) : [];
  const exParts = examples.flatMap((e, i) => [{ text: `CALIBRATION EXAMPLE ${i + 1} — the studio owner graded this ${e.expected === 'pass' ? 'DELIVERABLE (score 7+)' : 'REJECTED (score 4 or below)'}${e.why ? ': ' + e.why : ''}:` }, { inline_data: { mime_type: 'image/jpeg', data: e.data } }]);
  const parts = [{ text: rubric + (examples.length ? `\nBefore scoring, study the calibration examples of the owner's taste below and score the candidate the way the owner would.` : '') + `\nRespond with ONLY JSON: {"score": n, "reason": "one sentence"}` },
    ...exParts,
    { text: 'NOW THE CANDIDATE TO SCORE. Image 0 — original:' }, { inline_data: { mime_type: mime, data: originalB64 } },
    { text: 'Image 1 — candidate:' }, { inline_data: { mime_type: candidate.mime_type || 'image/jpeg', data: candidate.data } }];
  const json = await geminiGenerateContent(apiKey, model, { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, response_mime_type: 'application/json' } });
  const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  try { const v = JSON.parse(text); return { score: Number(v.score), reason: v.reason || '' }; } catch { return { score: null, reason: text.slice(0, 120) }; }
}

module.exports = { rankCandidates, scoreCandidate };
