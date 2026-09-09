#!/usr/bin/env node
/**
 * Listing Lab — transformation orchestrator (CLI prototype of POST /transform).
 *
 *   ORIGINAL PHOTO → APPROVED PROMPT → NANO BANANA PRO → COMPLIANCE JUDGE
 *        → (fail: retry up to MAX_ATTEMPTS, else reject+refund)
 *        → WATERMARK → WATERMARK VERIFY → DELIVER + AUDIT RECORD
 *
 * Usage:
 *   GEMINI_API_KEY=... node transform.js --input photo.jpg --type declutter
 *   GEMINI_API_KEY=... node transform.js --input room.jpg --type staging --style Coastal --room "Living Room"
 *   GEMINI_API_KEY=... node transform.js --input house.jpg --type twilight --style "Golden Hour"
 *
 * The original file is never modified — every output is a new derivative in out/.
 */
const fs = require('fs');
// Load .env for local CLI use (no-op if the var is already set or the file is absent).
try {
  const envFile = require('path').join(__dirname, '.env');
  if (!process.env.GEMINI_API_KEY && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {}
const path = require('path');
const { buildPrompt, WATERMARK_TEXT, ROOM_TYPES, STAGING_STYLES, TWILIGHT_MOODS, PRESERVATION } = require('./prompts');
const { nanoBananaEdit, setDeadline, msLeft, geminiGenerateContent } = require('./gemini');
const { vertexEdit, authMode: vertexAuthMode } = require('./vertex');
const meter = require('./meter.js');

/**
 * TWO FRONT DOORS TO THE SAME MODEL.
 *
 * `gemini-3-pro-image` can be reached two ways, and they are not the same thing
 * behind the scenes. The developer API (AI Studio) serves from a global shared
 * pool. Vertex — Google Cloud's front door — serves from its own. Same weights,
 * same output, different capacity.
 *
 * WHY THAT MATTERS ENOUGH TO KEEP BOTH WIRED
 * On 26 Aug 2026 the developer API returned 500 for over an hour: "gemini-3-pro-
 * image is currently experiencing high demand." Not our quota, not our key —
 * capacity, and no paid tier buys past it. Measured at 16:47 that day, while the
 * developer API was refusing every request, the identical prompt through Vertex
 * came back 200 with a picture in it.
 *
 * So Vertex is not a migration to be scheduled. It is the second door, and the
 * fallback below is the whole answer to "we can't be giving that error to a
 * client": if the first door is jammed, try the other one before anybody waits.
 *
 * `PROVIDER=vertex` still swaps the ORDER deliberately, for testing or if the
 * developer API ever becomes the worse of the two. What is never inferred is
 * using a door that has no credentials — a half-set environment variable must
 * not silently reroute a paying customer's job.
 */
const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase();
// Off only if explicitly disabled. The fallback costs nothing when the first
// door works, and it is the difference between a delivered photograph and an
// apology when it does not.
const FALLBACK = process.env.PROVIDER_FALLBACK !== '0';

/**
 * WHICH DOOR TO TRY FIRST — LEARNED, NOT DECIDED IN A CONFIG FILE.
 *
 * `PROVIDER` says where to START. It should not say where to stay, and setting
 * it by hand is a standing invitation to be wrong: on 26 Aug 2026 the developer
 * API was dead for five hours, so Vertex was made the first door — and within
 * the hour Vertex's image pool was exhausted while the developer API had
 * recovered. Every generation would then have knocked at the dead door first,
 * burned its two knocks, and fallen through. Correct answer, slowest possible
 * route to it, and a config change needed every time the weather turns.
 *
 * Both are pay-as-you-go against SHARED pools — Google's own wording for a
 * Vertex 429 is "Resource exhausted", the shared-quota message. Neither is
 * guaranteed and either can go down, so which one is healthy is a fact about
 * right now, not about the deployment.
 *
 * So the container remembers. The first generation that has to fall back moves
 * the preference for the rest of that instance's life, and the next job starts
 * at the door that just worked. Instances are short-lived, so a stale preference
 * corrects itself within minutes rather than needing a deploy.
 *
 * Same shape as the judge ladder in gemini.js, for the same reason: a thing that
 * varies minute to minute has to be decided at run time.
 */
let preferVertex = PROVIDER === 'vertex';
let _doors = {};
const _setDoors = (d) => { _doors = d || {}; };

/**
 * Is this door jammed, as opposed to the request being wrong?
 *
 * Only a capacity or transport failure is worth asking the other door about. A
 * 400, a refusal, a malformed prompt — those will fail identically over there,
 * and trying twice would just spend twice.
 */
// "User location is not supported" belongs here too. It is the most conclusive
// jam of all — the same request from the same place will be refused every time,
// so there is nothing to gain by waiting and everything to gain by knocking
// somewhere else. Vertex answered from container instances the developer API
// refused outright, measured 26 Aug 2026.
const DOOR_JAMMED = /\b(500|502|503|504|524|429)\b|UNAVAILABLE|high demand|overloaded|timed out|ran out of time|User location is not supported|FAILED_PRECONDITION/i;

// MODEL-LEVEL FALLBACK. The two doors above (developer API, Vertex) are two ways
// to reach the SAME model. When the model itself is overloaded — gemini-3-pro-image
// answering 500 "currently experiencing high demand", as it did for ~5 hours on
// 27 Aug 2026 — every door fails identically and door failover cannot help. This
// is the missing rung: when the primary model is down at every door, ask a
// different model. gemini-3.1-flash-image draws the same job ~3x faster; its one
// weakness (a slight uneven colour cast on empty rooms) is handled by giving it
// wider colour-lock limits below. Off only if explicitly disabled or a model was
// pinned via IMAGE_MODEL (an explicit pin is a deliberate choice, not a default
// to fall away from).
const MODEL_FALLBACK = process.env.MODEL_FALLBACK !== '0';
const FALLBACK_MODEL = process.env.FALLBACK_IMAGE_MODEL || 'gemini-3.1-flash-image';
// The signal that the MODEL (not the door) is unreachable: capacity/overload,
// AND our own rate limit. 429 was originally excluded on the theory that a rate
// limit "clears in under a minute and must not trigger a quality downgrade" —
// disproven in beta on 31 Aug 2026: parallel testers saturated the pro model's
// per-minute quota continuously, every retry re-tripped it, and two declutters
// sat "working" for over an hour while the flash fallback — wired for exactly
// this — never engaged, because 429 wasn't on this list. By the time
// generateViaDoors throws a 429 BOTH doors have already retried through it, so
// this is not one unlucky request; and flash draws against its own separate
// quota, so under a pro-quota crunch it actually answers. A slightly softer
// image beats a photo that never arrives. (Geo-blocks remain door problems the
// ladder handles.)
const MODEL_DOWN = /\b(500|503|429)\b|high demand|overloaded|unavailable|experiencing high|RESOURCE_EXHAUSTED|rate limit|quota/i;
// Wider colour-lock limits for the fallback model, whose cast is stronger and
// uneven. Grounded in the corrections that reconciled to <1 level residual on
// 27 Aug 2026 (offsets up to ~30, gain up to ~1.16). The residual check inside
// colorlock stays the real guardrail — a fit that cannot reconcile is still
// refused, so widening the door does not blind the exposure check.
const FALLBACK_COLOUR = { maxGain: 1.20, minGain: 0.82, maxOffset: 40 };
// Wider limits for EMPTY rooms too. Emptying a furnished room re-renders large
// blank wall/floor/ceiling areas, and the pro model's exposure on those bare
// surfaces drifts further than on a cluttered frame — several empty deliveries
// were refused here and failed the judge for "exposure changed" when the drift
// was a correctable tint, not a relight. These sit between pro's tight default
// and the fallback's wide one. The after-residual check (<=1.5 levels on the
// unchanged pixels) is still the guardrail: a real relight cannot fit one
// gain/offset back onto the original, so it is still refused and still judged.
const EMPTY_COLOUR = { maxGain: 1.18, minGain: 0.85, maxOffset: 22 };
// Staging re-renders the ENTIRE frame — more of the image changes than in any
// other transform — so the model's own colour rendering drifts further than a
// declutter's. Seen in beta (31 Aug 2026): a Standard staging produced three
// candidates whose only fatal flaw was a uniform blue offset of ~15 levels —
// gains all clean, a correctable tint, missing the default 14-level door by
// ~1.5 — so the lock refused to fix it and the judges failed the frame for
// "exposure off by 7.5/255". Same class of loss as the empty-room refusals that
// earned EMPTY_COLOUR its wider door, so staging gets the same one. The
// after-residual check (the fit must reconcile the unchanged pixels back to
// near-zero) is still the guardrail: a true relight cannot fit one gain/offset
// and is still refused and still judged.
const STAGING_COLOUR = { maxGain: 1.18, minGain: 0.85, maxOffset: 22 };

/**
 * The smallest window in which a generation can actually succeed.
 *
 * Every call clamps its own timeout to whatever the job has left, which is right
 * for a judge — a check that would have taken four seconds still takes four
 * seconds with twenty left. It is wrong for a generation. Image generation takes
 * 30–60 seconds and cannot be hurried, so starting one with forty-four seconds
 * in hand does not produce a fast picture: it produces a timeout, having spent
 * forty-four seconds of the customer's wait and possibly a charge at Google's
 * end for a frame nobody will ever see.
 *
 * Seen live on 26 Aug 2026: "Vertex request timed out after 44s" — a healthy
 * provider, a valid request, and no chance of finishing.
 *
 * So below this, do not knock at all. Fail immediately and retryably, and let
 * the queue start the job again with a whole budget in front of it.
 */
const MIN_GENERATION_MS = parseInt(process.env.MIN_GENERATION_MS || '75000', 10);

async function generateImage(apiKey, prompt, imageB64, mime, opts) {
  // A pin via IMAGE_MODEL is a deliberate choice and disables model fallback.
  if (IMAGE_MODEL) opts = { ...opts, model: IMAGE_MODEL };
  const primaryModel = opts.model || 'gemini-3-pro-image';

  const left = msLeft();
  if (left < MIN_GENERATION_MS) {
    const e = new Error(
      `not enough time left to generate (${(left / 1000).toFixed(0)}s; a generation needs about ` +
      `${(MIN_GENERATION_MS / 1000).toFixed(0)}s) — run interrupted, not failed`);
    e.outOfTime = true;
    throw e;
  }

  /**
   * FAL FIRST (1 Sep 2026, Kyle: "Google is so wishy washy" — approved with
   * the numbers on the table: $0.15/image at fal vs $0.134 direct, ~1.6 cents
   * for the calmest counter this week has offered). The ladder is REORDERED,
   * not shortened: fal serves the identical pro model first; Google's two
   * doors are the fallback, then flash, then FLUX. FAL_FIRST=0 flips the old
   * order back without a rebuild. Pinned models and flash itself never start
   * at fal — a deliberate pin means exactly what it says.
   */
  const falFirst = !!process.env.FAL_KEY && process.env.FAL_FIRST !== '0'
    && !IMAGE_MODEL && primaryModel !== FALLBACK_MODEL;
  if (falFirst) {
    try {
      const { falEdit } = require('./fal.js');
      const out = await falEdit(process.env.FAL_KEY, prompt, imageB64, mime, opts);
      out.model = primaryModel;
      out.door = 'fal';
      return out;
    } catch (eF) {
      if (eF.outOfTime) throw eF;
      console.log(`  fal front door refused (${String(eF && eF.message).slice(0, 80)}…) — falling back to Google's doors…`);
    }
  }
  try {
    const out = await generateViaDoors(apiKey, prompt, imageB64, mime, opts);
    out.model = primaryModel;
    return out;
  } catch (err) {
    // Google's own doors are shut — not our rate limit, not a geo-block.
    const modelDown = err.bothDoorsShut || MODEL_DOWN.test(String(err && err.message));
    if (!MODEL_FALLBACK || IMAGE_MODEL || primaryModel === FALLBACK_MODEL || !modelDown) throw err;
    /**
     * THE THIRD DOOR before any quality change (31 Aug 2026): fal.ai serves
     * the SAME pro model from its own capacity arrangements — see fal.js. Six
     * "high demand" windows in six days, and doors provably fail separately
     * (26 Aug: developer API refused for an hour while Vertex answered the
     * same minute) — so the identical dish gets one more counter before the
     * job settles for the faster cook. Primary model only: flash needs no
     * third door, it IS the last resort. Dormant without FAL_KEY.
     */
    if (process.env.FAL_KEY && !falFirst) {
      try {
        console.log(`  ${primaryModel} is down at Google's doors — knocking at the third door (fal, same model)…`);
        const { falEdit } = require('./fal.js');
        const out = await falEdit(process.env.FAL_KEY, prompt, imageB64, mime, opts);
        out.model = primaryModel;
        out.door = 'fal';
        return out;
      } catch (e3) {
        if (e3.outOfTime) throw e3;
        console.log(`  third door refused too (${String(e3 && e3.message).slice(0, 80)}…)`);
      }
    }
    console.log(`  ${primaryModel} is down at every door — falling back to ${FALLBACK_MODEL} (same job, different model)…`);
    try {
      const out = await generateViaDoors(apiKey, prompt, imageB64, mime, { ...opts, model: FALLBACK_MODEL });
      out.model = FALLBACK_MODEL;
      out.usedFallbackModel = true;
      return out;
    } catch (errFlash) {
      /**
       * STORM MODE (31 Aug 2026): both Google models down at every route.
       * FLUX.2 [pro] via fal — a different vendor entirely, the runner-up
       * for edits that leave untouched regions untouched — gets the last
       * knock. Its frames face the exact same judges, colour lock,
       * structural checks and watermark; the worst it can do is be refused.
       * Dormant without FAL_KEY; a storm failure re-throws flash's error so
       * the outage queue sees the familiar story.
       */
      const flashDown = errFlash.bothDoorsShut || MODEL_DOWN.test(String(errFlash && errFlash.message));
      if (!process.env.FAL_KEY || !flashDown) throw errFlash;
      try {
        console.log(`  ${FALLBACK_MODEL} is down too — STORM MODE: FLUX.2 via fal (different vendor, same checks)…`);
        const { falFluxEdit, FLUX_MODEL_NAME } = require('./fal.js');
        const out = await falFluxEdit(process.env.FAL_KEY, prompt, imageB64, mime, opts);
        out.model = FLUX_MODEL_NAME;
        out.door = 'fal';
        out.usedFallbackModel = true;
        return out;
      } catch (eStorm) {
        if (eStorm.outOfTime) throw eStorm;
        console.log(`  storm mode refused too (${String(eStorm && eStorm.message).slice(0, 80)}…)`);
        throw errFlash;
      }
    }
  }
}

// The two-door dance: developer API and Vertex, two routes to ONE model. Kept a
// separate function so generateImage can wrap it in a model-level fallback
// without the wrapper appearing to call itself (test/vertex.test.js guards the
// literal shape of the door calls below).
async function generateViaDoors(apiKey, prompt, imageB64, mime, opts) {
  // Injectable for tests only; defaults to the real clients. Lets a unit test
  // drive the model-fallback with fake doors — no network, no API cost, no
  // contention with a live run.
  const nano = _doors.nano || nanoBananaEdit;
  const vertex = _doors.vertex || vertexEdit;
  const wantsVertex = preferVertex;
  if (PROVIDER === 'vertex' && !vertexAuthMode()) throw new Error('PROVIDER=vertex but no Vertex credentials are set');

  const secondaryAvailable = wantsVertex ? !!apiKey : !!vertexAuthMode();

  /**
   * How long to keep knocking on a door before trying the other one.
   *
   * The HTTP client's own retry loop is five tries over about twenty-five
   * seconds, which is right when this is the only way in — most 503s clear.
   * With a second door standing open it is twenty-five seconds of a customer's
   * wait spent on a provider that has already said no. Measured on 26 Aug 2026
   * during the outage: 25s of retries, then Vertex answered on the first ask.
   *
   * So: knock twice, then try the other door. The full patience comes back if
   * that one refuses too, because then waiting really is the only option.
   */
  // With fal standing ready to serve the SAME model, the second Google door
  // gets the same two brisk knocks as the first — five patient tries at a
  // provider that just refused is time stolen from a door that answers in
  // seconds (1 Sep 2026, Kyle: "why are we waiting for Google when there's
  // fal?" — a job died 'not enough time left for the third door' that same
  // evening, its whole clock burned inside Google's retry ladders).
  const falStandsReady = !!process.env.FAL_KEY;
  // Brisk knocks whenever ANYWHERE better exists — a second Google door, or
  // fal. Full patience only when this door is genuinely the last one.
  const primaryOpts = (secondaryAvailable || falStandsReady) ? { ...opts, retries: 1 } : opts;
  const secondaryOpts = falStandsReady ? { ...opts, retries: 1 } : opts;
  const primary = wantsVertex
    ? () => vertex(apiKey, prompt, imageB64, mime, primaryOpts)
    : () => nano(apiKey, prompt, imageB64, mime, primaryOpts);
  // The same door, knocked at properly — used only once the other one has also
  // refused and the shortcut has stopped paying for itself.
  const primaryPatient = wantsVertex
    ? () => vertex(apiKey, prompt, imageB64, mime, opts)
    : () => nano(apiKey, prompt, imageB64, mime, opts);
  const secondary = wantsVertex
    ? () => nano(apiKey, prompt, imageB64, mime, secondaryOpts)
    : () => vertex(apiKey, prompt, imageB64, mime, secondaryOpts);

  try {
    return await primary();
  } catch (err) {
    if (!FALLBACK || !secondaryAvailable || !DOOR_JAMMED.test(String(err && err.message))) throw err;
    console.log(`  ${wantsVertex ? 'Vertex' : 'the developer API'} is refusing work ` +
      `(${String(err.message).slice(0, 70)}…) — trying the other door…`);
    try {
      const out = await secondary();
      // The other door works and this one does not. Start there next time —
      // otherwise every generation for the life of this container pays two
      // knocks at a door we have already been told is shut.
      preferVertex = !wantsVertex;
      console.log(`  ${wantsVertex ? 'the developer API' : 'Vertex'} answered. Same model, different capacity pool.` +
        ` Starting there from now on.`);
      return out;
    } catch (err2) {
      /**
       * Both doors shut — so go back and knock properly at the first one.
       *
       * The two knocks above were a deliberate shortcut, worth taking only
       * because there was somewhere better to be. There is not, and the reason
       * the first door said no matters now: a 429 is OUR rate limit against a
       * per-minute cap and clears in under a minute, which is the single most
       * recoverable failure in the whole system. Seen live on 26 Aug 2026 —
       * four concurrent jobs tripped Vertex's express-mode RPM cap, both doors
       * reported failure, and the same key answered 200 a minute later.
       *
       * Giving up here would park a job for ninety seconds over something that
       * fixes itself in thirty.
       */
      // With fal ready, "full patience" at a refusing Google door is the
      // wrong place to spend the clock: the ladder's next rung serves the
      // identical model from separate capacity, and the outage queue is the
      // patience if EVERY rung refuses. Without fal, the old logic stands —
      // waiting really is the only option then.
      if (falStandsReady) {
        console.log('  both Google doors refused — fal serves this same model, moving on without the long wait…');
        throw err2;
      }
      console.log(`  both doors refused — going back to the first with full patience…`);
      try {
        return await primaryPatient();
      } catch (err3) {
        // Now it is genuinely down everywhere. Report the state of the world,
        // with both failures attached, or a report reads as though only one
        // provider was ever tried.
        const e = new Error(`${err3.message} (other door also refused: ${String(err2.message).slice(0, 120)})`);
        e.bothDoorsShut = true;
        throw e;
      }
    }
  }
}
const { judgeComplianceVoted } = require('./compliance');
const { frameLock, frameScore } = require('./framelock');
const { reviewRegions, reviewOpenings } = require('./regionreview');
const { applianceCensus, verifyAppliances } = require('./appliancecheck');
const { uprightInput } = require('./orient');
const { inventoryRoom, inventoryExterior, inventoryFixed } = require('./inventory');
const { analyzeLayout, drawNoGoReference } = require('./layout');
const { pixelGuard } = require('./pixelguard');
/**
 * THE JURY DIET, half one (1 Sep 2026). A feature whose box the pixel guard
 * snapped overwhelmingly back to the original IS the original — inspecting it
 * is asking a judge whether a photocopy matches. Features below the threshold
 * (furniture-occluded, or too changed to snap) are still inspected in full.
 * PIXEL_GUARD_SKIP_AT=101 disables skipping without touching the guard.
 */
const GUARD_SKIP_AT = parseInt(process.env.PIXEL_GUARD_SKIP_AT || '75', 10);
function unguardedFeatures(fixedElements, guardStats, label) {
  const all = fixedElements || [];
  if (!guardStats || !Array.isArray(guardStats.perFeature)) return all;
  const pct = new Map(guardStats.perFeature.map(f => [f.name, f.snappedPctOfBox]));
  const keep = all.filter(f => (pct.get(f.name) ?? 0) < GUARD_SKIP_AT);
  const skipped = all.length - keep.length;
  if (skipped) console.log(`  ${label}: ${skipped}/${all.length} feature(s) are pixel-guarded photocopies — inspection skipped`);
  return keep;
}
const { writeStagingBrief } = require('./brief');
const { rankCandidates, scoreCandidate } = require('./rank');
const { locateFixed } = require('./structure');
const PROXIMITY_GATE = process.env.PROXIMITY_GATE === '1';
const { parseClientNotes } = require('./intent');
const { vsaiStage } = require('./vsai');
const crypto = require('crypto');
const { applyWatermark, verifyWatermark } = require('./watermark');
const { lockColour, matchDimensions, targetSize, imageSizeFor } = require('./colorlock');
const sharp = require('sharp');
const { classifyRemovals, clutterLine, keeperLine, gatingClutterLine } = require('./scope');
const maskedit = require('./maskedit');
const { sameFailure, persistentComplaint } = require('./converge');

// OUT_DIR is overridable so the container can give each job its own directory.
// Without it two jobs on the same photo and transformation write the same
// filename and clobber each other's result. Local CLI use is unchanged.
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * How many times a job may try before it gives up and refunds.
 *
 * Kyle, 26 Aug 2026: *"These customers want their photos. They don't want the
 * credit back."* He is right, and three was set when nobody had measured whether
 * a fourth would have helped. Measured since: a bedroom failed its first attempt
 * and passed its second, so retrying genuinely earns deliveries.
 *
 * Five, not more, because a credit costs $1.83 and an attempt costs about $0.22
 * — image plus checks — so the eighth attempt is the one that spends the whole
 * credit. Five keeps roughly 39% of it in the worst case and almost all of it in
 * the common one, because most jobs stop long before five (see converge.js).
 */
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || '5', 10);
// How many attempts a single un-fixed complaint may survive before we call the
// frame hopeless on that axis and stop. 3 = three full rounds of feedback got
// nowhere. Winnable frames keep their chances; only the stuck are cut short.
const EARLY_ABORT_STREAK = parseInt(process.env.EARLY_ABORT_STREAK || '3', 10);
/**
 * How long a job may take, wall clock, before it stops trying.
 *
 * Not a stopwatch that kills work mid-flight — a generation already sent is
 * already paid for, and cutting it wastes the money and delivers nothing. This
 * is the answer to a different question, asked before each RETRY: is there time
 * left to be worth another go?
 *
 * The numbers it is set against, measured on real jobs:
 *   generation   40–90s   (the model; the biggest and least predictable part)
 *   all checks   ~25s     (concurrent — the slowest one, not the sum)
 * so one full attempt is roughly 70–115 seconds. Three of them is six minutes,
 * which is how a job that "doesn't care about time" quietly became a ten-minute
 * wait for an agent watching a spinner.
 *
 * At 240s a first attempt always runs, a second almost always does, and a third
 * only when the first two were fast. A job that runs out is REJECTED, not
 * delivered — the credit goes back exactly as it does for a failed attempt.
 */
const JOB_BUDGET_S = parseInt(process.env.JOB_BUDGET_SECONDS || '300', 10);
/**
 * The hard backstop, further out than the budget on purpose.
 *
 * The budget decides whether to START another attempt. This is the line no
 * single HTTP call may cross, and it has to sit beyond the budget: an attempt
 * begun at 239s still deserves to finish its generation and be judged. Cutting
 * its judges off would throw away a photograph we already paid for and reject a
 * job that had a good result in hand.
 */
const JOB_DEADLINE_GRACE_S = parseInt(process.env.JOB_GRACE_SECONDS || '120', 10);
/**
 * The pipeline's deadline must expire BEFORE the container's SIGKILL.
 *
 * The masked-rescue extension used to set a deadline of 300+240+120 = 660s —
 * past the container's 600s hard kill. A declutter crawling through an outage
 * therefore never reached its own "out of time" conclusion: the kill arrived
 * first, carried no verdict, and the Worker re-ran the whole crawl. Every
 * deadline is now clamped 45s inside the kill, so the pipeline always gets to
 * finish its sentence — deliver, reject, or report the outage — and the kill
 * is reserved for a genuinely wedged process. (RUN_TIMEOUT_MS is the
 * container's own kill setting, passed through by server.js.)
 */
const KILL_CEILING_MS = Number(process.env.RUN_TIMEOUT_MS || 600000) - 45000;
const clampToKill = (jobStart, deadlineMs) => Math.min(deadlineMs, jobStart + KILL_CEILING_MS);
// What one more attempt costs, near enough to decide with. Deliberately the
// optimistic end: better to start an attempt that just overruns than to refuse
// one that would have made it.
const ATTEMPT_COST_S = parseInt(process.env.ATTEMPT_COST_SECONDS || '60', 10);
/**
 * Is this Google being down, rather than us being wrong?
 *
 * A generation that fails on 500/503/429/UNAVAILABLE has already been retried
 * five times inside the HTTP client, over about twenty-five seconds. Running the
 * whole attempt again is the same experiment a few seconds later. Measured
 * during a real outage on 26 Aug 2026: three attempts, twelve requests, 139
 * seconds, and an agent watching a spinner for all of it to be told Google was
 * busy — which the first attempt already knew.
 *
 * Two attempts is the evidence needed. It rules out a single unlucky request
 * and it keeps a spike that clears in ten seconds recoverable. Past that we stop
 * and say so, and the credit goes back exactly as it would anyway.
 */
const UPSTREAM_DOWN = /\b(500|502|503|504|524|429)\b|UNAVAILABLE|high demand|overloaded|timed out|ran out of time/i;
const UPSTREAM_STRIKES = parseInt(process.env.UPSTREAM_STRIKES || '2', 10);
const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gemini-3.6-flash';
/**
 * The requested render size. Left unset, it is chosen per photograph — anything
 * generated above the upload's own size is thrown away again on the way out, so
 * a 2048px upload rendered at 4K costs nearly twice as much and delivers the
 * identical file. An explicit IMAGE_SIZE still wins, for tests and experiments.
 */
const IMAGE_SIZE_OVERRIDE = process.env.IMAGE_SIZE || null;
/**
 * Which image model draws the picture. Overridable because on 27 Aug 2026
 * gemini-3-pro-image returned 500 "currently experiencing high demand" at every
 * resolution while gemini-3.1-flash-image answered normally — and our failover
 * ladder could not help, because all three of its rungs (direct, Vertex, proxy)
 * are routes to the SAME model. A door is no use when the room behind every
 * door is shut. Default unchanged; this only makes the alternative reachable.
 */
const IMAGE_MODEL = process.env.IMAGE_MODEL || null;
// Two votes since the teardown (2 Sep 2026): with one judge instead of
// twelve checkers, the bench shrinks too — both votes must pass (2/2 under
// the passes*2 > n rule), so the bar is unanimity, not leniency.
const JUDGE_VOTES = parseInt(process.env.JUDGE_VOTES || '2', 10);
// Staging is the flagship: each round generates CANDIDATES in parallel (each with its own
// brief/draw), judges all, and a head-stager call picks the best compliant one.
const STAGING_CANDIDATES = parseInt(process.env.STAGING_CANDIDATES || '3', 10);
const STAGING_ROUNDS = parseInt(process.env.STAGING_ROUNDS || '2', 10);
/**
 * How many declutter/empty candidates to draw per round. 1 is the original
 * sequential behaviour, unchanged. Above 1, a round fires that many independent
 * generations in parallel and delivers the best furniture-preserving one — the
 * same tactic that carries staging to a 100% delivery rate. Removal's sequential
 * retries were giving up at 76% because the failure that repeats (losing the
 * glass coffee table) is systematic, so a second identical roll converges to a
 * refund; independent parallel draws rarely all lose the same table.
 */
const DECLUTTER_CANDIDATES = parseInt(process.env.DECLUTTER_CANDIDATES || '1', 10);
/**
 * Empty room uses the parallel-candidate path; declutter does NOT (measured 28
 * Aug 2026: multi-candidate rescued 2 of 3 failed empties → 92% delivery, but
 * only 1 of 9 failed declutters, because declutter's failure is systematic —
 * the model erases the same furniture every draw — while empty's is variable).
 * HYBRID: the first round is a SINGLE candidate, because ~77% of empties pass on
 * the first try and fanning out three ways there just triples the bill on the
 * easy ones. Only a RETRY fans out to the full count, spending the extra draws
 * where they actually change the odds.
 */
const EMPTY_CANDIDATES = parseInt(process.env.EMPTY_CANDIDATES || '3', 10);
/**
 * MASKED DECLUTTER — the furniture-preserving path, on by default for
 * declutter (MASKED_DECLUTTER=0 restores the classic whole-frame loop).
 * Architecture proven 28 Aug 2026 on the worst golden frame (0/4 classic
 * attempts delivered; masked path passed the judge 3/3): segment the clutter
 * once, believe the model's render only inside those regions, fill stubborn
 * regions with tight crop edits, and everywhere else deliver the
 * photographer's own pixels. See maskedit.js for the full argument.
 */
const MASKED_DECLUTTER = process.env.MASKED_DECLUTTER !== '0';
// Three rounds: round 1 fills most regions, round 2 re-rolls near-misses and
// picks up scope-audit finds, round 3 is the last word on the stubborn one or
// two. A round with fills already in hand costs one full render plus only the
// crops still needed, so the marginal rounds are the cheap ones.
const MASKED_ROUNDS = parseInt(process.env.MASKED_ROUNDS || '3', 10);
const MAX_CROP_GENS = parseInt(process.env.MAX_CROP_GENS || '6', 10);
/**
 * WHICH PATH LEADS IS DECIDED PER FRAME, BY COVERAGE (2 Sep 2026).
 *
 * The 28 Aug measurement stands: two HEAVY-clutter frames that classic
 * delivered first try (bulk clearing is what a whole-frame render is good at)
 * REJECTED under masked-first — a big dog crate's revealed area is more than
 * a crop edit reconstructs faithfully. But the 1 Sep board read showed the
 * other side of the coin at scale: most declutter kills were collateral
 * damage OUTSIDE the clutter — a TV "removed", storage bins invented,
 * cables mangled — precisely what the masked composite makes impossible,
 * because everything outside the clutter regions is the photographer's own
 * pixels by construction, not by inspection.
 *
 * So the router is the segmentation itself, which runs up front either way:
 * clutter covering a SMALL share of the frame (the nursery, the tidy room)
 * → masked leads, classic is the fallback; clutter covering a LARGE share
 * (the packed garage) → classic leads, masked stays the rescue. One
 * threshold, measured per photo, never a global bet either way.
 *
 * RETIRED AS THE DEFAULT (5 Sep 2026). The audit of 67 production jobs told
 * the story the router's argument could not: 62 led masked, 8% of those
 * first rounds passed, and the dominant failures were "clutter left" and
 * "ghost/residue" — the composite's own weaknesses, at a median 6.2 minutes
 * and $1.11 a job. Classic-first with the catalogue in the prompt, the wide
 * colour door and the viewing-scale review delivered 19 of 20 fresh frames
 * at a median of about a minute and $0.22, 16 of them on the first render.
 * Masked stays as the rescue. MASKED_FIRST=1 restores the router.
 */
const CLASSIC_TRIES = parseInt(process.env.DECLUTTER_CLASSIC_TRIES || '2', 10);
const MASKED_FIRST = process.env.MASKED_FIRST === '1';
// Both thresholds are arithmetic over the segmenter's traced outlines — see
// maskedit.coverage(). No model opinion is consulted (the scene classifier
// called Kyle's lightly-cluttered nursery "too full"; it does not get a vote).
const MASKED_FIRST_MAX_PCT = parseFloat(process.env.MASKED_FIRST_MAX_PCT || '25');
const MASKED_FIRST_MAX_REGION_PCT = parseFloat(process.env.MASKED_FIRST_MAX_REGION_PCT || '8');
// The masked rescue needs its own clock — it starts where classic stopped.
const MASKED_EXTRA_S = parseInt(process.env.MASKED_EXTRA_SECONDS || process.env.MASKED_EXTRA_S || '240', 10);
// How far apart the parallel staging candidates START. See the comment at the
// candidate loop: they run for 30–60s each, so a few seconds of stagger is free
// and keeps three simultaneous requests from tripping a per-minute rate limit.
const CANDIDATE_STAGGER_MS = parseInt(process.env.CANDIDATE_STAGGER_MS || '4000', 10);
const MIN_DESIGN_SCORE = parseFloat(process.env.MIN_DESIGN_SCORE || '6');
// Which generator produces each staging candidate slot. 'nano' = our Nano Banana pipeline
// (brief + layout + draw); 'vsai' = Virtual Staging AI (room+style only). Default all nano;
// e.g. STAGING_SOURCES=nano,nano,vsai to A/B VSAI as the third candidate, or vsai,vsai,vsai
// to run VSAI-only (one render request with 3 variations = one VSAI "photo").
const STAGING_SOURCES = (process.env.STAGING_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean);
const VSAI_KEY = process.env.VSAI_API_KEY; // head-stager score below this is never delivered

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

/**
 * Every render passes through here before anything else looks at it.
 *
 * The model does not edit the photograph, it re-renders the whole frame, so its
 * own colour rendering and its own idea of resolution land on the output — a
 * bathroom declutter came back red +5 / blue +4 against the original on the walls
 * and floor nothing had been done to, at 5056px from a 4096px source. Both are
 * put back here, BEFORE the judges see the image, so what is judged is what
 * ships. Twilight is exempt: relighting the scene is the work.
 *
 * `gen` is mutated in place because it is threaded through the rest of the run as
 * base64; the audit gets the numbers either way, including when the correction
 * was refused and why.
 */
async function normaliseRender(gen, originalBuf, type, label, audit) {
  if (type === 'twilight') return gen;
  const record = { label };
  try {
    let generated = Buffer.from(gen.data, 'base64');
    // One decode, one encode. Correcting and then resizing separately walked a
    // 50-megapixel frame through sharp twice and got the container killed.
    const resizeTo = await targetSize(originalBuf, generated);
    // The fallback model's cast is stronger and uneven, so it gets wider limits.
    // Pro keeps the tight default. The residual check inside lockColour is the
    // guardrail either way — a correction that cannot reconcile is still refused.
    // Flash and storm-mode FLUX both re-render with a stronger cast than pro,
    // so both get the wide correction door; the residual check stays the judge.
    // DECLUTTER gets the same widened door as empty (5 Sep 2026): in the 2–4 Sep
    // audits every candidate the colour gate killed had passed the judge 2/2 —
    // a closet whose dark wardrobe became white shelving reads as a 10–14 level
    // "exposure shift" on the calmest 60% of pixels, and the tight door refused
    // to correct it. The residual check after correction is still the gate,
    // and the judge's own lighting check still catches a light switched on.
    // DECLUTTER_COLOUR_WIDE=0 restores the tight door.
    const colourLimits = (gen.model === FALLBACK_MODEL || gen.model === 'flux-2-pro') ? FALLBACK_COLOUR
      : type === 'empty' ? EMPTY_COLOUR
      : type === 'staging' ? STAGING_COLOUR
      : (type === 'declutter' && process.env.DECLUTTER_COLOUR_WIDE !== '0') ? EMPTY_COLOUR
      : {};
    const locked = await lockColour(originalBuf, generated, { resizeTo, ...colourLimits });
    record.colour = {
      applied: locked.applied, reason: locked.reason, before: locked.before,
      after: locked.after, gains: locked.gains, offsets: locked.offsets,
      unchangedShare: locked.unchangedShare, within: locked.within,
      limits: locked.limits, model: gen.model || null,
    };
    let out = locked.buf;
    // If the correction was refused, the resize still has to happen on its own.
    if (!locked.applied && resizeTo) {
      const sized = await matchDimensions(originalBuf, out);
      out = sized.buf;
    }
    record.size = resizeTo ? { resized: true, to: resizeTo } : { resized: false };
    generated = null;
    gen.data = out.toString('base64');
    gen.mime_type = 'image/jpeg';
    const drift = locked.before ? locked.before.map(v => Math.abs(v)) : [];
    const worst = drift.length ? Math.max(...drift).toFixed(1) : '?';
    console.log(`  colour: drift ${worst}/255 ${locked.applied ? 'corrected' : 'NOT corrected — ' + locked.reason}` +
      (resizeTo ? `; resized to ${resizeTo.join('×')}` : ''));
  } catch (e) {
    // A failure here must not lose a paid render. The uncorrected frame goes on
    // to the judges exactly as before this step existed.
    record.error = e.message.slice(0, 200);
    console.error('  colour lock error:', e.message.slice(0, 160));
  }
  (audit.colour = audit.colour || []).push(record);
  return record;
}

/**
 * The numeric colour gate, as opposed to the correction.
 *
 * The correction handles ordinary drift. This catches the case it deliberately
 * refuses — a shift too large to be rendering noise, which means the scene itself
 * came back lit or exposed differently — and the case where the correction ran and
 * did not land. Either way the frame misstates how the property looks, and the
 * judges cannot be relied on to see it: three of them passed a 2% cast.
 */
const COLOUR_GATE = parseFloat(process.env.COLOUR_GATE || '3.0'); // levels, 0–255
function colourViolation(record) {
  if (!record || !record.colour || record.error) return null;
  const c = record.colour;
  const residual = c.applied ? c.after : c.before;
  if (!residual) return null;
  const worst = Math.max(...residual.map(v => Math.abs(v)));
  if (worst <= COLOUR_GATE) return null;
  return c.applied
    ? `The colour of the room could not be brought back to the original photograph (off by ${worst.toFixed(1)}/255 after correction).`
    : `The whole frame came back lit or exposed differently from the original photograph (off by ${worst.toFixed(1)}/255), which misstates how the property looks.`;
}

async function main() {
  // Wall clock for the whole job, started before anything is read or generated,
  // so the budget below measures what the agent actually waits.
  const JOB_START = Date.now();
  const elapsed = () => (Date.now() - JOB_START) / 1000;
  // Every Gemini call from here on measures its own timeout and its own retries
  // against this. Without it, four retries at three minutes each is twelve
  // minutes of patience inside one call nobody is waiting that long for.
  setDeadline(clampToKill(JOB_START, JOB_START + (JOB_BUDGET_S + JOB_DEADLINE_GRACE_S) * 1000));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error('Set GEMINI_API_KEY'); process.exit(1); }

  const inputPath = arg('input');
  const type = arg('type');
  const options = { style: arg('style'), room: arg('room'), notes: arg('notes') };
  if (!inputPath || !type) { console.error('Need --input and --type'); process.exit(1); }
  // Validate closed option sets up front — the API layer must do the same (400, no credit charged).
  if (type === 'staging') {
    if (!STAGING_STYLES[options.style]) { console.error(`--style must be one of: ${Object.keys(STAGING_STYLES).join(', ')}`); process.exit(1); }
    if (!ROOM_TYPES[options.room]) { console.error(`--room must be one of: ${Object.keys(ROOM_TYPES).join(' | ')}`); process.exit(1); }
  }
  if (type === 'twilight' && !TWILIGHT_MOODS[options.style]) { console.error(`--style must be one of: ${Object.keys(TWILIGHT_MOODS).join(', ')}`); process.exit(1); }

  // UPRIGHT FIRST (3 Sep 2026): an iPhone portrait arrives sideways with a
  // rotation tag. Turned here, once, so the model, every instrument and the
  // delivered frame all see the room the way the agent does — see orient.js.
  let originalBuf = fs.readFileSync(inputPath);
  {
    const up = await uprightInput(originalBuf);
    if (up.oriented) { originalBuf = up.buf; console.log(`— input carried EXIF orientation ${up.orientation}; pixels turned upright before anything read them`); }
  }
  const mime = inputPath.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
  const originalB64 = originalBuf.toString('base64');
  const stem = path.basename(inputPath).replace(/\.[^.]+$/, '');
  // Filename-safe, not just space-free: 'Basement / Rec Room' used to keep its
  // slash and split the output path into a directory that doesn't exist —
  // FATAL ENOENT on the first slash-named room anyone ever staged (Kyle,
  // 31 Aug 2026, the first Basement / Rec Room in production).
  const tag = [type, options.style, options.room].filter(Boolean).join('-').replace(/[^A-Za-z0-9-]+/g, '');
  const originalMeta = await sharp(originalBuf).metadata();
  const IMAGE_SIZE = IMAGE_SIZE_OVERRIDE || imageSizeFor(originalMeta);
  console.log(`— Source ${originalMeta.width}x${originalMeta.height}; rendering at ${IMAGE_SIZE}` +
    (IMAGE_SIZE_OVERRIDE ? ' (IMAGE_SIZE override)' : ''));
  const audit = { input: inputPath, type, options, provider: PROVIDER, judgeModel: JUDGE_MODEL, judgeVotes: JUDGE_VOTES,
    imageSize: IMAGE_SIZE, imageSizeChosenBy: IMAGE_SIZE_OVERRIDE ? 'override' : 'source photo',
    source: { width: originalMeta.width, height: originalMeta.height },
    attempts: [], startedAt: new Date().toISOString() };

  /**
   * Reading the room, before anything is generated.
   *
   * These two look at the SAME photograph and neither needs the other's answer,
   * so they run together. Sequentially they were 12.2s + 11.0s measured against
   * the real model; concurrently they cost the slower of the two. That is ~11
   * seconds off every job, before a single pixel is generated.
   *
   * Structural verification needs each fixed feature as a BOX in the original so
   * every one can be cropped and checked on its own later. Interior types only —
   * twilight is graded against the exterior rules instead.
   */
  const catalogue =
    type === 'empty' ? inventoryFixed(apiKey, originalB64, mime, JUDGE_MODEL)
    : type === 'declutter' ? inventoryRoom(apiKey, originalB64, mime, JUDGE_MODEL)
    : null;
  const locating = type !== 'twilight'
    ? locateFixed(apiKey, JUDGE_MODEL, originalB64, mime)
    : null;
  // THE APPLIANCE CENSUS (Kyle, 3 Sep 2026: "removing the range is never
  // acceptable, even in an empty room"). One call on the original; the roll
  // call below runs on every candidate that is otherwise about to pass.
  // OFF BY DEFAULT (Kyle, same day): the written rule in the prompts and the
  // judge's own checks carry it — the roll call was built to get five out of
  // five on one test photo with a person standing in front of the range,
  // which real uploads almost never have. APPLIANCE_CHECK=1 switches it on.
  const censusing = type !== 'twilight' && process.env.APPLIANCE_CHECK === '1'
    ? applianceCensus(apiKey, JUDGE_MODEL, originalB64, mime).catch(e => { console.error('  appliance census unavailable (non-fatal): ' + e.message.slice(0, 100)); return []; })
    : Promise.resolve([]);
  if (catalogue || locating) console.log('— Reading the room (catalogue + fixed features, together)…');
  const [catalogueOut, locatedOut, applianceList] = await Promise.all([catalogue, locating, censusing]);
  audit.appliances = applianceList;
  applianceList.forEach(a => console.log('  appliance: ' + a.label));
  /**
   * Roll call for a candidate that is about to pass: every censused appliance
   * must still be there, up close. Returns the violations to add (none when
   * the room has no appliances — the common case, and free).
   */
  const applianceRollCall = async (gen, label) => {
    if (!applianceList.length) return [];
    try {
      const r = await verifyAppliances(apiKey, JUDGE_MODEL, originalBuf, Buffer.from(gen.data, 'base64'), applianceList);
      if (r.ok) { console.log(`  ${label}: appliance roll call — all ${r.verdicts.length} present`); return []; }
      console.log(`  ${label}: APPLIANCE FAIL — ${r.missing.length} missing/replaced`);
      r.missing.forEach(t => console.log('    ✗ ' + t));
      return r.missing.map(t => `A major appliance that sells with the home is gone or changed — ${t}`);
    } catch (e) { console.error(`  ${label}: appliance roll call unavailable (non-fatal): ` + e.message.slice(0, 100)); return []; }
  };
  if (catalogueOut) {
    options.inventory = catalogueOut;
    options.inventory.keep.forEach(k => console.log(`  ${type === 'empty' ? 'fixed' : 'keep'}: ` + k));
    (options.inventory.clutter || []).forEach(c => console.log('  clutter: ' + c));
    options.inventory.lights.forEach(l => console.log(`  light: ${l.fixture} = ${l.state}`));
  }

  /**
   * IS THERE ANYTHING HERE TO DO?
   *
   * A declutter on a room with no clutter in it has no honest output. The model
   * still tries — it is being asked to — so it takes the only movable thing in
   * the frame and calls that decluttering. Measured on `k-office.jpg`, a bare
   * room with one small dark object against a wall: attempt one removed it (a
   * cabinet, on the keep list), attempt two left it alone and returned a photo
   * identical to the input, which "nothing was actually removed" then refused.
   * Every path ends in a refund; the only question is how much of Kyle's money
   * gets spent reaching it. Five attempts is about a dollar against a $1.83
   * credit, for an answer available here for a fraction of a cent — the
   * catalogue call has already happened.
   *
   * DELIBERATELY CONSERVATIVE, because the asymmetry runs the other way. Kyle's
   * own rule in `offeredFor`: refusing work an agent actually wants is worse
   * than allowing work that turns out to be pointless. So this refuses only when
   * the catalogue ANSWERED the question and answered "nothing", and only when it
   * clearly looked — a keep list with real items in it. A missing field, an
   * unparseable reply, or an empty catalogue all mean "I could not tell", and
   * the job runs.
   */
  if (type === 'declutter' && Array.isArray(options.inventory?.clutter)
      && options.inventory.clutter.length === 0 && options.inventory.keep.length >= 3) {
    console.log('\n— Nothing to declutter: the catalogue found furniture and fixtures but no clutter.');
    audit.nothingToDo = { keep: options.inventory.keep.length, clutter: [] };
    audit.outcome = 'not_applicable';
    audit.creditCharged = false;
    audit.finishedAt = new Date().toISOString();
    audit.timing = { totalSeconds: 0, jobSeconds: +elapsed().toFixed(1), budgetSeconds: JOB_BUDGET_S, cumulative: {} };
    const p = path.join(OUT_DIR, `${stem}.${tag}.audit.json`);
    fs.writeFileSync(p, JSON.stringify(audit, null, 2));
    console.log('\n════════════════════════════════════');
    console.log('NOT APPLICABLE — this room already reads clean, so there is nothing to remove.');
    console.log('The original photograph is unchanged. No credit spent.');
    console.log(`Audit record → ${p}`);
    return;
  }
  if (locatedOut) {
    options.fixedElements = locatedOut;
    options.fixedElements.forEach(f => console.log(`  fixed: ${f.name} [${f.kind}] x ${f.x_from}-${f.x_to}% y ${f.y_from}-${f.y_to}%`));
    audit.fixedElements = options.fixedElements;
  }
  if (type === 'staging') {
    console.log('— Analysing layout (doors / keep-clear zones)…');
    options.layout = await analyzeLayout(apiKey, originalB64, mime, JUDGE_MODEL, options.room);
    options.layout.roomType = options.room;
    options.layout.doors.forEach(d => { const z = d.clear_zone || {}; console.log(`  door: ${d.name} → clear x ${z.x_from}-${z.x_to}% y ${z.y_from}-${z.y_to}%`); });
    console.log('  placement: ' + options.layout.placement);
    options.inventory = options.layout; // judge reads .doors from here
    // The same zones, drawn: a red-box copy of the photo rides along as a
    // reference image, because coordinates in prose were being ignored under
    // furniture-crowding pressure (see drawNoGoReference).
    try {
      options.noGoRef = await drawNoGoReference(sharp, originalBuf, options.layout);
      if (options.noGoRef) console.log(`  no-go reference drawn (${options.layout.doors.filter(d => d.clear_zone).length} zone(s))`);
    } catch (e) { console.error('  no-go reference failed (continuing without): ' + e.message.slice(0, 100)); }
    if (options.notes) {
      console.log('— Parsing client notes…');
      options.intent = await parseClientNotes(apiKey, JUDGE_MODEL, options.notes, options.room, options.style);
      const a = options.intent.accepted || {};
      console.log('  honoured: ' + JSON.stringify(a));
      (options.intent.ignored || []).forEach(i => console.log(`  ignored: "${i.text}" — ${i.reason}`));
      audit.clientNotes = options.intent;
    }
    // Fresh furnishing brief per request (and per attempt — see loop) so no two rooms share a showroom.
    audit.briefs = [];
  }
  const newBrief = async (attempt) => {
    const seed = crypto.createHash('sha1').update(`${inputPath}|${type}|${options.style}|${options.room}|${Date.now()}|${attempt}`).digest('hex').slice(0, 8);
    const b = await writeStagingBrief(apiKey, originalB64, mime, JUDGE_MODEL, options.room, options.style, options.layout, seed, options.intent);
    if (b) { console.log(`  brief (${seed}): ${b.concept}`); (b.pieces || []).slice(0, 4).forEach(p => console.log('    · ' + p)); audit.briefs.push({ attempt, seed, ...b }); }
    return b;
  };
  if (type === 'staging') { options.brief = await newBrief(1); }
  // Twilight is two generations: neutralise the sun (overcast), then relight to the mood.
  let stageInputB64 = originalB64, stageInputMime = mime;
  const TWO_PASS = process.env.TWILIGHT_TWO_PASS === '1'; // opt-in: flattens contrast; default single pass
  if (type === 'twilight' && TWO_PASS) {
    console.log('— Stage 1/2: overcast neutralisation (removing sun shadows)…');
    const t0 = Date.now();
    const oc = await generateImage(apiKey, buildPrompt(type, { ...options, stage: 'overcast' }), originalB64, mime, { imageSize: IMAGE_SIZE });
    stageInputB64 = oc.data; stageInputMime = oc.mime_type;
    const ocPath = path.join(OUT_DIR, `${stem}.${tag}.overcast.jpg`);
    fs.writeFileSync(ocPath, Buffer.from(oc.data, 'base64'));
    console.log(`  overcast pass in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${ocPath}`);
    audit.overcast = ocPath;
  }
  audit.inventory = options.inventory || null;
  audit.layout = options.layout || null;
  const T = { start: Date.now(), stages: {} };
  // Cumulative marks, kept because the console line and older audits read them.
  // What actually answers "where did the time go" is T.meter.phases — DURATIONS.
  // Kyle, before the 88-frame run: "I don't wanna see time, meanwhile is what
  // we're getting to." A mark saying the judge finished at 34s does not tell you
  // the judge took four seconds and the generation before it took thirty.
  let lastLapAt = T.start;
  T.meter = meter.setMeter(meter.newMeter());
  const lap = (k) => {
    const now = Date.now();
    T.stages[k] = ((now - T.start) / 1000).toFixed(1) + 's';
    T.meter.phases.push({ name: k, ms: now - lastLapAt, atMs: lastLapAt - T.start });
    lastLapAt = now;
  };
  if (type === 'twilight') {
    console.log('— Building structure manifest…');
    options.manifest = await inventoryExterior(apiKey, originalB64, mime, JUDGE_MODEL);
    console.log('  ' + options.manifest.description);
    options.manifest.fixtures.forEach(f => console.log('  fixture: ' + f));
    console.log('  landscape lights visible: ' + options.manifest.landscapeLights);
    audit.manifest = options.manifest;
    lap('manifest');
  }
  // Twilight: show the model a real day→twilight pair from our own shoot as a worked example.
  let references;
  if (type === 'twilight') {
    const refDir = path.join(__dirname, 'refs');
    const day = path.join(refDir, 'twilight-day.jpg'), real = path.join(refDir, 'twilight-real.jpg');
    if (fs.existsSync(day) && fs.existsSync(real)) {
      references = [
        { label: 'EXAMPLE — this property photographed in daytime:', data: fs.readFileSync(day).toString('base64') },
        { label: 'EXAMPLE — the SAME property photographed by our photographer at real twilight. Use it as a reference for the sky and the soft shadow-free light. Your output may be exposed darker and moodier than this example, and the windows should be warmly lit.', data: fs.readFileSync(real).toString('base64') },
      ];
      console.log('— Using day→twilight reference pair from refs/');
      audit.references = [day, real];
    }
  }
  let prompt = buildPrompt(type, options);

  let delivered = null;
  if (type === 'staging') {
    let candIdx = 0;
    for (let round = 1; round <= STAGING_ROUNDS && !delivered; round++) {
      console.log(`\n— Round ${round}/${STAGING_ROUNDS}: ${STAGING_CANDIDATES} candidates in parallel…`);
      const roundT0 = Date.now();
      const slots = Array.from({ length: STAGING_CANDIDATES }, (_, i) => i);
      // VSAI slots are batched: one render request with N variations costs one VSAI photo.
      const vsaiSlots = slots.filter(i => (STAGING_SOURCES[i] || 'nano') === 'vsai');
      let vsaiBatch = null;
      if (vsaiSlots.length) {
        if (!VSAI_KEY) console.error('  vsai requested but VSAI_API_KEY not set — those slots will error');
        else vsaiBatch = vsaiStage(VSAI_KEY, `data:${mime};base64,${originalB64}`, options.room, options.style, { variations: vsaiSlots.length, renderId: audit.vsaiRenderId })
          .then(b => { if (b[0]?.renderId) audit.vsaiRenderId = b[0].renderId; return b; })
          .catch(e => ({ error: e.message }));
      }
      const results = await Promise.all(slots.map(async (i) => {
        const n = ++candIdx;
        const source = STAGING_SOURCES[i] || 'nano';
        /**
         * Stagger the candidates rather than firing them all at once.
         *
         * Staging is the only transformation that generates several frames in
         * parallel, and image generation is rate-limited per MINUTE. Three
         * requests in the same instant is the worst possible shape for that:
         * measured 26 Aug 2026, a staging job hit `Vertex 429: Resource
         * exhausted` on every candidate, then again on retry, and spent three
         * rounds in the outage queue without ever producing a frame — while a
         * single generation from the same key seconds later returned 200.
         *
         * The candidates take 30–60 seconds each and run concurrently, so
         * spacing their STARTS by a few seconds costs the job almost nothing
         * and takes the burst out of the burst. Harmless once the account's
         * quota is raised; the difference between working and not until then.
         */
        if (i > 0) await new Promise(r => setTimeout(r, i * CANDIDATE_STAGGER_MS));
        const t0 = Date.now();
        let gen, brief = null;
        if (source === 'vsai') {
          if (!vsaiBatch) return { n, source, error: 'no VSAI_API_KEY' };
          const batch = await vsaiBatch;
          if (batch.error) { console.error(`  cand ${n} [vsai]: ${batch.error.slice(0, 140)}`); return { n, source, error: batch.error }; }
          gen = batch[vsaiSlots.indexOf(i)];
          if (!gen) return { n, source, error: 'VSAI returned fewer variations than requested' };
        } else {
          brief = await newBrief(n);
          const p = buildPrompt(type, { ...options, brief });
          try { gen = await generateImage(apiKey, p, originalB64, mime, { imageSize: IMAGE_SIZE, references: options.noGoRef ? [options.noGoRef] : undefined }); }
          catch (e) { console.error(`  cand ${n}: generation error: ${e.message.slice(0, 120)}`); return { n, source, error: e.message }; }
        }
        // Before the candidate is saved, judged or ranked — the room's own colour
        // must survive being furnished.
        const colourRecord = await normaliseRender(gen, originalBuf, type, `cand${n}`, audit);
        // PIXEL GUARD (on by default since 1 Sep 2026; PIXEL_GUARD=0 disables):
        // fixed features snap back to the original's
        // exact pixels before any judge looks — see pixelguard.js.
        if (process.env.PIXEL_GUARD !== '0' && (options.fixedElements || []).length) {
          try {
            const pg = await pixelGuard(sharp, originalBuf, gen, options.fixedElements);
            gen.data = pg.data; gen.mime_type = pg.mime_type; gen.pixelGuard = pg.stats;
            audit.pixelGuard = (audit.pixelGuard || []).concat([{ label: `cand${n}`, ...pg.stats }]);
            console.log(`  cand ${n}: pixel guard snapped ${pg.stats.snappedPct}% of frame across ${pg.stats.features} feature(s)`);
          } catch (e) { console.error(`  cand ${n}: pixel guard failed (raw candidate used): ` + e.message.slice(0, 100)); }
        }
        const rawExt = /png/i.test(gen.mime_type) ? 'png' : 'jpg';
        const rawPath = path.join(OUT_DIR, `${stem}.${tag}.cand${n}.${source}.raw.${rawExt}`);
        fs.writeFileSync(rawPath, Buffer.from(gen.data, 'base64'));
        console.log(`  cand ${n} [${source}]: generated in ${((Date.now() - t0) / 1000).toFixed(1)}s (${brief ? brief.concept : source === 'vsai' ? 'VSAI: room+style only' : 'no brief'})`);
        /**
         * THE TEARDOWN (2 Sep 2026, Kyle: "rip all these judges out down to
         * the originals and give better prompts"). The prescreen bouncer, the
         * phantom-claim vetter, the separate structural gate, the focal gates,
         * the repair-pass re-jury and the realism gate all stood here once —
         * twelve model opinions per candidate, and the golden set scored the
         * pile 44/61, identical to a week earlier. ONE judge remains, asked
         * one well-written question; everything deterministic (colour lock,
         * pixel guard, watermark verify) stays because arithmetic has never
         * hallucinated. The deleted checkers' questions moved into the
         * judge's own checklist in compliance.js.
         */
        /**
         * THE FRAME LOCK, staging edition (Kyle's grade, 2 Sep 2026: a
         * delivered staging failed because "the frame moved"). Staged
         * furniture adds legitimate new edges, so staging gets its own
         * conservative gate: his framing fail scored 0.271, every staging he
         * passed 0.37–0.68. Declutter and empty keep judge-only camera checks
         * — those measured perfect on his grades, and an instrument nobody
         * needs is a checker too many.
         */
        const stagingLockMin = parseFloat(process.env.FRAMELOCK_MIN_STAGING || '0.32');
        if (stagingLockMin > 0) {
          let fl = null;
          try { fl = await frameScore(Buffer.from(originalB64, 'base64'), Buffer.from(gen.data, 'base64')); } catch {}
          if (fl && fl.score < stagingLockMin) {
            console.log(`  cand ${n}: FRAME LOCK FAIL — edge alignment ${fl.score} < ${stagingLockMin}`);
            return { n, source, raw: rawPath, error: null, verdict: { pass: false, passes: 0, votes: 0, violations: [`frame lock: edge alignment ${fl.score} < ${stagingLockMin} — the camera moved`] }, framelock: fl };
          }
        }
        let verdict;
        try { verdict = await judgeComplianceVoted(apiKey, type, originalB64, mime, gen.data, gen.mime_type, JUDGE_MODEL, options.inventory, JUDGE_VOTES); }
        catch (e) { console.error(`  cand ${n}: judge error: ${e.message.slice(0, 120)}`); return { n, raw: rawPath, error: e.message }; }
        const colourFault = colourViolation(colourRecord);
        if (colourFault) {
          verdict.pass = false;
          verdict.violations = (verdict.violations || []).concat([colourFault]);
          console.log(`  cand ${n}: COLOUR FAIL — ${colourFault}`);
        }
        if (verdict.pass) {
          const gone = await applianceRollCall(gen, `cand ${n}`);
          if (gone.length) { verdict.pass = false; verdict.violations = (verdict.violations || []).concat(gone); }
        }
        console.log(`  cand ${n}: ${verdict.pass ? 'PASS' : 'FAIL'} (${verdict.passes}/${verdict.votes})` + (verdict.violations.length ? ' — ' + verdict.violations[0].slice(0, 110) : ''));
        return { n, source, gen, raw: rawPath, verdict, brief, colour: colourRecord && colourRecord.colour };
      }));
      T.meter.phases.push({ name: `stage-round${round}`, ms: Date.now() - roundT0, atMs: roundT0 - T.start });
      results.forEach(r => audit.attempts.push({ round, candidate: r.n, source: r.source || 'nano', raw: r.raw, error: r.error, verdict: r.verdict, colour: r.colour, brief: r.brief && { seed: r.brief.seed, concept: r.brief.concept, draw: r.brief.draw } }));
      let compliant = results.filter(r => r.verdict && r.verdict.pass);
      console.log(`  ${compliant.length}/${results.length} compliant`);
      // (Structural gate, focal gates: removed in the teardown, 2 Sep 2026 —
      // pixel guard protects catalogued features deterministically, and the
      // one judge's checklist carries the architecture and keep-clear rules.)
      // (The repair pass: removed in the teardown, 2 Sep 2026 — a near-miss
      // now feeds the next round's retry prompt instead of a private re-jury.)
      if (!compliant.length) continue;
      // (Realism critic gate: removed in the teardown, 2 Sep 2026 — the one
      // judge's universal-artifacts check carries ghosting and warps now.)
      if (!compliant.length) continue;
      console.log('  head stager ranking…');
      const rank = await rankCandidates(apiKey, JUDGE_MODEL, originalB64, mime, compliant.map(r => r.gen), options.room, options.style);
      const ordered = rank.order.map(i => compliant[i]);
      ordered.forEach((r, i) => console.log(`  #${i + 1}: cand ${r.n} [${r.source}] — score ${rank.scores[rank.order[i]] ?? '?'} — ${rank.reasons[String(rank.order[i] + 1)] || ''}`));
      audit.ranking = { round, order: ordered.map(r => r.n), scores: rank.scores, reasons: rank.reasons };
      const bestScore = rank.scores[rank.order[0]];
      /**
       * The design-score REJECTION is gone (2 Sep 2026). Measured on Kyle's
       * 61 graded photos: frames he passed scored 3–4 and were killed here;
       * frames he failed scored 7–8 and sailed through. The score was
       * ANTI-correlated with his grading — a taste opinion rejecting
       * sellable work while catching nothing. Ranking stays (choosing the
       * best of the passers is what it is for); rejection by taste does not.
       */
      if (bestScore !== undefined && bestScore < MIN_DESIGN_SCORE) {
        console.log(`  best design score ${bestScore} < ${MIN_DESIGN_SCORE} — noted, delivering anyway (the score chooses, it no longer rejects)`);
      }
      const best = ordered[0];
      const wmText = WATERMARK_TEXT[type];
      const preWmBuf = Buffer.from(best.gen.data, 'base64');
      const finalBuf = await applyWatermark(preWmBuf, wmText);
      // Pass the pre-watermark frame so the check can confirm those pixels
      // actually changed, rather than inferring presence from brightness.
      const wmCheck = await verifyWatermark(finalBuf, wmText, preWmBuf);
      if (!wmCheck.present) {
        const aWm = audit.attempts.find(x => x.candidate === best.n); if (aWm && !aWm.killedBy) aWm.killedBy = 'watermark';
        console.error('  watermark verification FAILED'); continue;
      }
      audit.watermark = { text: wmText, ...wmCheck };
      const outPath = path.join(OUT_DIR, `${stem}.${tag}.approved.jpg`);
      fs.writeFileSync(outPath, finalBuf);
      /**
       * THE CLEAN COPY (1 Sep 2026). "Stage this room" chains a delivered
       * empty back through the pipeline, and feeding the model its own
       * "Virtually emptied" stamp taught it to redraw that stamp under the
       * fresh one — a garbled double watermark reached a delivery on 31 Aug.
       * Prompt orders alone did not stop it. So the pre-watermark frame ships
       * alongside the delivery, is stored server-side where no customer route
       * serves it, and becomes the starting photo for chained edits. Every
       * image a customer ever SEES still carries exactly one stamp.
       */
      fs.writeFileSync(outPath.replace(/\.approved\.jpg$/, '.approved.clean.jpg'), preWmBuf);
      delivered = outPath; audit.delivered = outPath; audit.deliveredCandidate = best.n; audit.deliveredSource = best.source;
      /**
       * VERSIONS, NOT DISCARDS (Kyle, 28 Aug 2026). Every candidate here has
       * already passed the full compliance suite and the realism critic — the
       * renders are bought, judged, and were being thrown away. Up to two
       * runners-up ship alongside the winner as "Version 2" / "Version 3", so
       * taste gets an answer ("pick the other couch") that costs nothing to
       * generate. Watermarked exactly like the winner; never promised as three
       * — only what genuinely passed goes out.
       */
      audit.variants = [];
      for (let vi = 1; vi <= 2 && ordered[vi]; vi++) {
        const vPath = path.join(OUT_DIR, `${stem}.${tag}.approved.v${vi + 1}.jpg`);
        const vPre = Buffer.from(ordered[vi].gen.data, 'base64');
        const vBuf = await applyWatermark(vPre, wmText);
        const vCheck = await verifyWatermark(vBuf, wmText, vPre);
        if (!vCheck.present) { console.error(`  version ${vi + 1} watermark FAILED — not shipped`); continue; }
        fs.writeFileSync(vPath, vBuf);
        audit.variants.push({ path: vPath, candidate: ordered[vi].n, score: rank.scores[rank.order[vi]] ?? null });
        console.log(`APPROVED-EXTRA → ${vPath}`);
      }
    }
  }
  /**
   * Everything a FAILED attempt has to do before the next one starts.
   * Returns true when there is no point starting one.
   *
   * TELLING THE GENERATOR WHAT WENT WRONG
   * `buildPrompt` has taken `priorViolations` since Round 19 and appends them as
   * "a previous attempt was REJECTED for the following reasons". Until now it was
   * passed in exactly ONE place — the declutter scope check — so every ORDINARY
   * compliance rejection retried with a byte-identical prompt and learned
   * nothing. Three attempts, one instruction, and the difference between them was
   * luck. That is the real reason retries were not converging, and it is a much
   * better answer to Kyle's *"why not just run it again?"* than raising the
   * count: the second attempt was never actually a second attempt.
   *
   * KNOWING WHEN TO STOP
   * Retrying only earns anything while something is changing. Two consecutive
   * attempts that fail in exactly the same way are not bad luck — see
   * converge.js — and each one costs about $0.22 against a $1.83 credit.
   */
  let lastViolations = null;
  const violationHistory = [];
  const prepareRetry = (verdict) => {
    const repeated = sameFailure(lastViolations, verdict.violations);
    lastViolations = (verdict.violations || []).slice();
    violationHistory.push(lastViolations);
    const stuck = repeated ? null : persistentComplaint(violationHistory, EARLY_ABORT_STREAK);
    if (repeated || stuck) {
      console.log(repeated
        ? '\n— Same failure twice, word for word. Another attempt would produce it a third time.'
        : `\n— One problem has survived ${EARLY_ABORT_STREAK} rounds of feedback ("${String(stuck).slice(0, 90)}"). The generator can't fix it; stopping rather than paying for a fourth.`);
      audit.stoppedRepeating = { after: audit.attempts.length, reason: repeated ? 'identical-failure' : 'persistent-complaint', violations: lastViolations.slice(0, 4) };
      return true;
    }
    // Hand the judge's own words back to the generator, so the next attempt is
    // an answer to this one rather than another roll of the dice.
    prompt = buildPrompt(type, { ...options, priorViolations: verdict.violations });
    return false;
  };

  // ---- Multi-candidate removal path (declutter/empty), opt-in ---------------
  // Evaluate ONE finished candidate against every removal gate and return a
  // decided verdict plus how thorough it was, without delivering. Mirrors the
  // sequential loop's checks exactly so the two paths judge by one standard.
  const isRemovalJob = type === 'declutter' || type === 'empty';
  const removalCandidates = type === 'empty' ? EMPTY_CANDIDATES : DECLUTTER_CANDIDATES;
  const evalRemovalCandidate = async (gen, label, opts = {}) => {
    const colourRecord = await normaliseRender(gen, originalBuf, type, label, audit);
    // PIXEL GUARD (bench-gated) — see pixelguard.js.
    if (process.env.PIXEL_GUARD !== '0' && (options.fixedElements || []).length) {
      try {
        const pg = await pixelGuard(sharp, originalBuf, gen, options.fixedElements);
        gen.data = pg.data; gen.mime_type = pg.mime_type; gen.pixelGuard = pg.stats;
        audit.pixelGuard = (audit.pixelGuard || []).concat([{ label, ...pg.stats }]);
        console.log(`  ${label}: pixel guard snapped ${pg.stats.snappedPct}% across ${pg.stats.features} feature(s)`);
      } catch (e) { console.error(`  ${label}: pixel guard failed (raw candidate used): ` + e.message.slice(0, 100)); }
    }
    const rawExt = /png/i.test(gen.mime_type) ? 'png' : 'jpg';
    const rawPath = path.join(OUT_DIR, `${stem}.${tag}.${label}.raw.${rawExt}`);
    fs.writeFileSync(rawPath, Buffer.from(gen.data, 'base64'));
    const genBuf = Buffer.from(gen.data, 'base64');
    /**
     * THE TEARDOWN (2 Sep 2026, Kyle: "rip all these judges out down to the
     * originals and give better prompts"). Five model checks stood here —
     * structure verifier, removal verifier, clutter-left verifier, over-reach
     * classifier, phantom vetter — plus the jury. The golden set scored the
     * whole pile 44/61, unchanged in a week. ONE judge remains; its checklist
     * in compliance.js now carries the deleted checkers' questions
     * (clutter-all-gone with the tiny-leftover rule, nothing-overremoved,
     * ghost-free erases). Colour lock and pixel guard stay — arithmetic has
     * never hallucinated. The masked plan's own accounting (which regions
     * were actually filled) replaces the "was anything removed?" vision call
     * it always disagreed with.
     */
    let judged;
    try { judged = { ok: true, v: await judgeComplianceVoted(apiKey, type, originalB64, mime, gen.data, gen.mime_type, JUDGE_MODEL, options.inventory, JUDGE_VOTES) }; }
    catch (e) { judged = { ok: false, e }; }
    if (!judged.ok) return { pass: false, error: judged.e.message, raw: rawPath, gen };
    const verdict = judged.v;
    const colourFault = colourViolation(colourRecord);
    if (colourFault) { verdict.pass = false; verdict.violations = (verdict.violations || []).concat([colourFault]); }
    let rem = null;
    if (opts.maskedPlan) {
      rem = { removedAnything: opts.maskedPlan.some(p => !p.kept), items: opts.maskedPlan.filter(p => !p.kept).map(p => p.label) };
      if (!rem.removedAnything) { verdict.pass = false; verdict.violations = (verdict.violations || []).concat(['Nothing was actually removed from this room, so there is nothing to disclose.']); }
    }
    /**
     * THE REGION CLOSE-UP REVIEW (3 Sep 2026). Kyle's "insane ghosting"
     * delivery hid a wall smudge and a mottled table in 3% of the frame — the
     * whole-frame judge missed it one measurement run in four, and arithmetic
     * measured nothing (a plausible smudge is statistically tame). This is
     * the SAME judge asked the same ghost question with proper evidence:
     * close-up before/after crops of exactly the regions the masked path
     * edited. Benched on his graded triple: both bad deliveries flagged with
     * the right diagnosis, the clean one passed, four runs out of four. One
     * flash call, only on a candidate that is otherwise about to deliver.
     */
    if (verdict.pass) {
      const gone = await applianceRollCall(gen, label);
      if (gone.length) { verdict.pass = false; verdict.violations = (verdict.violations || []).concat(gone); }
    }
    let review = null;
    if (verdict.pass && opts.reviewRegions && opts.reviewRegions.length && process.env.REGION_REVIEW !== '0') {
      try {
        review = await reviewRegions(apiKey, JUDGE_MODEL, originalBuf, genBuf, opts.reviewRegions);
        if (!review.ok) {
          verdict.pass = false;
          verdict.violations = (verdict.violations || []).concat(
            review.residue.map(t => `Residue left behind at close range — ${t}`));
          console.log(`  ${label}: REGION REVIEW FAIL — ${review.residue.length} region(s) show residue`);
          review.residue.forEach(t => console.log('    ✗ ' + t));
        } else {
          console.log(`  ${label}: region review clean (${review.verdicts.length} regions)`);
        }
      } catch (e) { console.error(`  ${label}: region review unavailable (non-fatal): ` + e.message.slice(0, 100)); }
    }
    return { pass: verdict.pass, verdict, gen, rem, review, colour: colourRecord && colourRecord.colour, raw: rawPath,
      remainingCount: 0, minorCount: (verdict.minor || []).length, scope: null, realism: null };
  };

  // Segmentation, its own step so the COVERAGE ROUTER (see below) can measure
  // the frame before any path spends a render. Returns {regions, segSeconds}
  // — regions may be an empty array (nothing traced) or null (calls failed).
  const segmentClutter = async () => {
    const segT0 = Date.now();
    const SEG_MODEL = process.env.SEG_MODEL || JUDGE_MODEL;
    let regions = null;
    // Two tries with a pause: measured 28 Aug 2026, two of nine validation jobs
    // never got a rescue at all because the one segmentation call failed under
    // concurrent load. A rescue that dies on its first HTTP request rescued
    // nothing — the retry is the difference between "the path exists" and
    // "the path runs".
    for (let segTry = 1; segTry <= 2 && !regions; segTry++) {
      try {
        // GATING categories only, and cords called out as keepers by name:
        // the masked path tried to erase a wall TV's cables (cords are in the
        // full clutter list, non-gating) and delivered textbook ghosting —
        // half-erased cords the checks never looked at (2 Sep 2026, Kyle).
        // What the pipeline is not required to clean, it must not touch.
        regions = await maskedit.detectAndTrace({ geminiGenerateContent }, apiKey, SEG_MODEL, originalB64, mime, gatingClutterLine(),
          keeperLine() + '; power cords and cables attached to a television, appliance or electronics that stay');
      } catch (e) {
        console.error(`  clutter segmentation failed (try ${segTry}/2): ` + String(e.message).slice(0, 140));
        if (segTry === 1) await new Promise(r => setTimeout(r, 8000));
      }
    }
    /**
     * Cross-check every region label against the scope rule with the SAME
     * classifier the over-reach check uses. Measured 28 Aug 2026: the segmenter
     * offered "cluttered rolling cart" and "mirror leaning on floor" as clutter
     * regions — both keepers — so the fills removed real furnishings and the
     * judge (rightly) refused the composite. A region the classifier calls a
     * FURNISHING never becomes a region at all; "unclear" stays (the ring and
     * the judge still protect it downstream).
     */
    if (regions && regions.length) {
      try {
        const cls = await classifyRemovals(apiKey, JUDGE_MODEL, regions.map(r => r.label));
        if (cls && Array.isArray(cls.classified)) {
          const furnishing = new Set(cls.classified.filter(c => c && c.class === 'furnishing').map(c => String(c.item)));
          const before = regions.length;
          regions = regions.filter(r => {
            const isFurn = [...furnishing].some(fLabel => fLabel.includes(String(r.label).slice(0, 40)) || String(r.label).includes(fLabel.slice(0, 40)));
            if (isFurn) console.log(`   − region "${r.label}" classified as FURNISHING — dropped, it stays`);
            return !isFurn;
          });
          if (regions.length !== before) audit.maskedDroppedRegions = before - regions.length;
        }
      } catch (e) { /* classifier unavailable — regions stand, judge still guards */ }
    }
    return { regions, segModel: SEG_MODEL, segSeconds: +((Date.now() - segT0) / 1000).toFixed(1) };
  };

  // The masked path itself. `seg` comes from segmentClutter(); `budgetS` is the
  // wall-clock this run measures itself against (base budget when it LEADS,
  // extended when it rescues); `rounds` likewise.
  const runMasked = async (seg, { budgetS, rounds } = {}) => {
    const regions = seg && seg.regions;
    budgetS = budgetS || (JOB_BUDGET_S + MASKED_EXTRA_S);
    rounds = rounds || MASKED_ROUNDS;
    if (!regions || !regions.length) {
      console.log('— masked path: no clutter regions segmented; nothing to work with');
    } else {
      const W = originalMeta.width, H = originalMeta.height;
      console.log(`— masked declutter: ${regions.length} clutter regions (${regions.filter(r => r.polygons).length} traced) in ${seg.segSeconds}s`);
      regions.forEach(r => console.log(`   · ${r.label}${r.polygons ? '' : ' (untraceable — will stay)'}`));
      audit.masked = { segModel: seg.segModel, segSeconds: seg.segSeconds,
        regions: regions.map(r => ({ label: r.label, box_2d: r.box_2d, traced: !!r.polygons })) };
      const fills = [];
      // Seed with the classic phase's failed renders — already paid for,
      // already colour-locked, and their GOOD regions are perfectly usable
      // fills even though the frame as a whole was rejected.
      for (const a of audit.attempts) {
        if (a.raw && a.verdict && fs.existsSync(a.raw)) {
          try {
            let buf = fs.readFileSync(a.raw);
            const m = await sharp(buf).metadata();
            if (m.width !== W || m.height !== H) buf = await sharp(buf).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).toBuffer();
            fills.push({ buf, left: 0, top: 0, width: W, height: H, name: `classic${a.attempt}` });
          } catch (e) { /* unreadable seed — skip */ }
        }
      }
      if (fills.length) console.log(`  seeded with ${fills.length} classic render(s)`);
      let cropGens = 0;
      // Per-region attempt counter drives the escalation ladder in cropFill:
      // each retry of the same region is a DIFFERENT experiment (wider context,
      // then a different model), never the same dice again.
      const regionCropTries = new Map();
      for (let round = 1; round <= rounds && !delivered; round++) {
        if (round > 1 && elapsed() + ATTEMPT_COST_S > budgetS) {
          console.log(`\n— Out of time after ${elapsed().toFixed(0)}s of ${budgetS}s (masked clock). Stopping.`);
          audit.stoppedForTime = { elapsedSeconds: +elapsed().toFixed(1), budgetSeconds: budgetS, afterAttempts: round - 1 };
          break;
        }
        // Round 1 lives off the seeds; a fresh feedback-updated render is only
        // worth buying when the seeds have already come up short.
        if (round > 1 || !fills.length) try {
          console.log(`\n— Masked round ${round}/${rounds}: whole-frame render…`);
          const gen = await generateImage(apiKey, prompt, stageInputB64, stageInputMime, { imageSize: IMAGE_SIZE, references });
          await normaliseRender(gen, originalBuf, type, `masked-full${round}`, audit);
          // Resize to the original's exact dimensions like the seed path does
          // (2 Sep 2026: a 2K render pushed with a 4K original's claimed size
          // made every rect extract run off the buffer — "extract_area: bad
          // extract area", fatal, on both big-photo benches).
          {
            let fullBuf = Buffer.from(gen.data, 'base64');
            const fm = await sharp(fullBuf).metadata();
            if (fm.width !== W || fm.height !== H) fullBuf = await sharp(fullBuf).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).toBuffer();
            fills.push({ buf: fullBuf, left: 0, top: 0, width: W, height: H, name: `full${round}` });
          }
        } catch (e) {
          console.error('  generation error:', String(e.message).slice(0, 140));
          audit.attempts.push({ attempt: round, stage: 'generate', error: e.message });
          const outages = audit.attempts.filter(a => a.stage === 'generate' && UPSTREAM_DOWN.test(a.error || ''));
          if (outages.length >= UPSTREAM_STRIKES) {
            console.log(`— Google's image model refused ${outages.length} attempts. Stopping.`);
            audit.upstreamDown = { attempts: outages.length, lastError: String(e.message).slice(0, 300) };
            break;
          }
          if (!fills.length) continue;   // no fills at all yet — try next round
        }
        const fillsBefore = fills.length;
        let asm = await maskedit.assemble(originalBuf, regions, fills, W, H);
        // Crop edits for regions no fill served — the stubborn ones. The crop
        // budget is PER ROUND: a later round re-rolls a near-miss region with
        // fresh dice instead of arriving with an empty wallet (measured 28 Aug
        // 2026: round 2 had no budget left, changed nothing, and spent a full
        // render finding that out).
        const unserved = regions.filter((r, i) => r.polygons && asm.plan[i] && asm.plan[i].kept);
        const todo = unserved.slice(0, MAX_CROP_GENS);
        if (todo.length) {
          console.log(`  ${todo.length} region(s) unserved — crop edits…`);
          const crops = await Promise.all(todo.map(async (r, k) => {
            if (k > 0) await new Promise(res => setTimeout(res, k * CANDIDATE_STAGGER_MS));
            const attempt = regionCropTries.get(r) || 0;
            regionCropTries.set(r, attempt + 1);
            try { return await maskedit.cropFill({ generateImage, lockColour }, apiKey, originalBuf, r, W, H, { attempt }); }
            catch (e) { console.error(`  crop "${r.label}": ${String(e.message).slice(0, 90)}`); return null; }
          }));
          cropGens += todo.length;
          crops.filter(Boolean).forEach(f => fills.push(f));
          asm = await maskedit.assemble(originalBuf, regions, fills, W, H);
        }
        if (fills.length === fillsBefore && round > 1) {
          console.log('  no new fills this round — nothing can change; stopping');
          break;
        }
        console.log(`  assembled: ${asm.cleaned} cleaned, ${asm.kept} kept original`);
        asm.plan.forEach(p => console.log(p.kept ? `   ✗ ${p.label} — ${p.kept}` : `   ✓ ${p.label} — ring ${p.ring} from ${p.from}`));
        console.log('  checking the composite (full suite)…');
        const compositeGen = { data: asm.buf.toString('base64'), mime_type: 'image/jpeg' };
        // Only the regions the assembly actually EDITED go to the close-up
        // review — a kept region still holds its item on purpose.
        const editedRegions = regions.filter((r, i) => asm.plan[i] && !asm.plan[i].kept);
        const ev = await evalRemovalCandidate(compositeGen, `masked${round}`, { maskedPlan: asm.plan, reviewRegions: editedRegions });
        audit.attempts.push({ attempt: round, masked: true, plan: asm.plan, cropGens, raw: ev.raw, verdict: ev.verdict, review: ev.review, colour: ev.colour, removal: ev.rem, scope: ev.scope, realism: ev.realism, error: ev.error });
        if (ev.verdict) console.log(`  verdict: ${ev.pass ? 'PASS' : 'FAIL'} (${ev.verdict.passes}/${ev.verdict.votes})` + ((ev.verdict.violations || []).length ? ' — ' + ev.verdict.violations[0].slice(0, 110) : ''));
        if (ev.pass) {
          const wmText = WATERMARK_TEXT[type];
          const preWmBuf = asm.buf;
          const finalBuf = await applyWatermark(preWmBuf, wmText);
          const wmCheck = await verifyWatermark(finalBuf, wmText, preWmBuf);
          if (!wmCheck.present) { console.error('  watermark verification FAILED — next round'); continue; }
          audit.watermark = { text: wmText, ...wmCheck };
          const outPath = path.join(OUT_DIR, `${stem}.${tag}.approved.jpg`);
          fs.writeFileSync(outPath, finalBuf);
          // The clean (pre-watermark) frame for chained edits — see the note
          // at the staging delivery site. EVERY delivery site writes this.
          fs.writeFileSync(outPath.replace(/\.approved\.jpg$/, '.approved.clean.jpg'), preWmBuf);
          delivered = outPath; audit.delivered = outPath; audit.deliveredBy = 'masked';
          console.log(`  DELIVERED masked composite → ${outPath}`);
          break;
        }
        // THE AUDIT LOOP, judge edition (2 Sep 2026). It used to read the
        // separate clutter-left verifier; the teardown removed that, and for
        // one bench run the loop was dead — the judge NAMED the plush toys
        // the segmenter missed and nothing could act on it. Now the one
        // judge's own leftover-clutter complaints become the next round's
        // new regions: same loop, one voice.
        const leftoverTexts = ((ev.verdict && ev.verdict.violations) || [])
          .map(String)
          .filter(v => /clutter|left behind|remain|still (in|on|visible)|was not removed|left unedited/i.test(v))
          .slice(0, 4);
        if (leftoverTexts.length && round < rounds) {
          console.log(`  the judge named ${leftoverTexts.length} leftover(s) the segmenter missed — tracing for next round…`);
          const extra = await Promise.all(leftoverTexts.map(t =>
            maskedit.traceOne({ geminiGenerateContent }, apiKey, seg.segModel, originalB64, mime,
              `the personal clutter items described here: "${t.slice(0, 160)}"`, null)));
          extra.filter(Boolean).forEach(r => {
            console.log(`   + new region: ${r.label.slice(0, 60)}`);
            regions.push(r);
          });
        }
        if (ev.verdict && prepareRetry(ev.verdict)) break;
      }
    }
  };

  // ---- THE COVERAGE ROUTER (2 Sep 2026) --------------------------------------
  // For declutter, segmentation runs BEFORE any render is bought, and pure
  // arithmetic over the traced outlines picks which path leads. Small clutter
  // share and no oversized single item → masked leads (everything outside the
  // clutter is the photographer's own pixels by construction — the collateral
  // kills that dominated the 1 Sep board CANNOT happen). Bulk-clearing frames
  // → classic leads, masked stays the rescue (28 Aug measurement stands).
  // Whichever path led, the OTHER still gets the extended clock as fallback.
  let jobBudgetS = JOB_BUDGET_S;
  let maskedSeg = null;      // reused by the rescue — segmentation is paid once
  let maskedLed = false;
  if (type === 'declutter' && MASKED_DECLUTTER && MASKED_FIRST && !delivered) {
    maskedSeg = await segmentClutter();
    const regions = maskedSeg && maskedSeg.regions;
    if (regions && regions.length) {
      const cov = maskedit.coverage(regions);
      audit.coverageRouter = { ...cov, maxPct: MASKED_FIRST_MAX_PCT, maxRegionPct: MASKED_FIRST_MAX_REGION_PCT };
      const small = cov.unionPct <= MASKED_FIRST_MAX_PCT && cov.largestPct <= MASKED_FIRST_MAX_REGION_PCT;
      audit.coverageRouter.leads = small ? 'masked' : 'classic';
      console.log(`— coverage router: clutter ${cov.unionPct}% of frame, largest item ${cov.largestPct}%` +
        (cov.largestLabel ? ` ("${String(cov.largestLabel).slice(0, 50)}")` : '') + ` → ${small ? 'MASKED leads' : 'classic leads'}`);
      if (small) {
        maskedLed = true;
        await runMasked(maskedSeg, { budgetS: JOB_BUDGET_S, rounds: Math.min(3, MASKED_ROUNDS) });
        if (!delivered && !audit.upstreamDown) {
          // Classic takes over on the extended clock — the mirror image of the
          // old order, so total patience is unchanged, only who goes first.
          jobBudgetS = JOB_BUDGET_S + MASKED_EXTRA_S;
          setDeadline(clampToKill(JOB_START, JOB_START + (jobBudgetS + JOB_DEADLINE_GRACE_S) * 1000));
          console.log('\n— Masked did not deliver; classic whole-frame takes the extended clock.');
        }
      }
    } else {
      console.log('— coverage router: segmentation came back empty — classic leads, nothing to mask');
    }
  }

  if (isRemovalJob && removalCandidates > 1) {
    for (let round = 1; round <= MAX_ATTEMPTS && !delivered; round++) {
      if (round > 1 && elapsed() + ATTEMPT_COST_S > jobBudgetS) {
        console.log(`\n— Out of time after ${elapsed().toFixed(0)}s of ${jobBudgetS}s. Stopping.`);
        audit.stoppedForTime = { elapsedSeconds: +elapsed().toFixed(1), budgetSeconds: jobBudgetS, afterAttempts: round - 1 };
        break;
      }
      // Hybrid: one candidate on the first round (most frames pass there), fan
      // out to the full count only on a retry, where the extra draws earn their
      // cost.
      const k = round === 1 ? 1 : removalCandidates;
      console.log(`\n— Round ${round}/${MAX_ATTEMPTS}: ${k} candidate${k > 1 ? 's in parallel' : ''} (${type})…`);
      const roundT0 = Date.now();
      const gens = await Promise.all(Array.from({ length: k }, (_, i) => i).map(async (i) => {
        if (i > 0) await new Promise(r => setTimeout(r, i * CANDIDATE_STAGGER_MS));
        try { return { g: await generateImage(apiKey, prompt, stageInputB64, stageInputMime, { imageSize: IMAGE_SIZE, references }) }; }
        catch (e) { return { error: e.message }; }
      }));
      const genErrors = gens.filter(x => x.error);
      genErrors.forEach(x => { console.error('  generation error:', String(x.error).slice(0, 120)); audit.attempts.push({ attempt: round, stage: 'generate', error: x.error }); });
      if (genErrors.length === gens.length) {
        const outages = audit.attempts.filter(a => a.stage === 'generate' && UPSTREAM_DOWN.test(a.error || ''));
        if (outages.length >= UPSTREAM_STRIKES) { console.log(`— Google's image model refused ${outages.length} attempts. Stopping.`); audit.upstreamDown = { attempts: outages.length, lastError: String(genErrors.at(-1).error).slice(0, 300) }; break; }
        continue;
      }
      const evals = await Promise.all(gens.map((x, i) => x.g ? evalRemovalCandidate(x.g, `round${round}c${i + 1}`) : Promise.resolve({ pass: false, error: x.error })));
      evals.forEach((e, i) => { if (!e.error || e.verdict) audit.attempts.push({ attempt: round, candidate: i + 1, raw: e.raw, verdict: e.verdict, colour: e.colour, removal: e.rem, scope: e.scope, realism: e.realism, error: e.error }); });
      evals.forEach((e) => { if (e.verdict) console.log(`  cand: ${e.pass ? 'PASS' : 'FAIL'} (${e.verdict.passes}/${e.verdict.votes})` + (e.verdict.violations && e.verdict.violations.length ? ' — ' + e.verdict.violations[0].slice(0, 100) : '')); });
      T.meter.phases.push({ name: `removal-round${round}`, ms: Date.now() - roundT0, atMs: roundT0 - T.start });
      const passers = evals.filter(e => e.pass);
      if (passers.length) {
        // Best furniture-preserving delivery: fewest clutter items still in the
        // frame, then fewest minor issues. All passers already kept the furniture.
        passers.sort((a, b) => (a.remainingCount - b.remainingCount) || (a.minorCount - b.minorCount));
        const best = passers[0];
        const wmText = WATERMARK_TEXT[type];
        let finalBuf;
        if (wmText) {
          const preWmBuf = Buffer.from(best.gen.data, 'base64');
          finalBuf = await applyWatermark(preWmBuf, wmText);
          const wmCheck = await verifyWatermark(finalBuf, wmText, preWmBuf);
          if (!wmCheck.present) { console.error('  watermark verification FAILED — next round'); continue; }
          audit.watermark = { text: wmText, ...wmCheck };
        } else { finalBuf = Buffer.from(best.gen.data, 'base64'); audit.watermark = { text: null, required: false }; }
        const outPath = path.join(OUT_DIR, `${stem}.${tag}.approved.jpg`);
        fs.writeFileSync(outPath, finalBuf);
        // The clean frame for chained edits (see the staging delivery site).
        // Only when a stamp went on — an unstamped delivery IS its clean copy.
        if (wmText) fs.writeFileSync(outPath.replace(/\.approved\.jpg$/, '.approved.clean.jpg'), Buffer.from(best.gen.data, 'base64'));
        delivered = outPath; audit.delivered = outPath;
        console.log(`  DELIVERED best of ${passers.length}/${evals.length} passing candidates → ${outPath}`);
        break;
      }
      // Nothing passed this round — hand the most common violation back and retry.
      const tally = {};
      evals.forEach(e => ((e.verdict && e.verdict.violations) || []).forEach(v => { tally[v] = (tally[v] || 0) + 1; }));
      const merged = { violations: Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([v]) => v) };
      if (prepareRetry(merged)) break;
    }
  }

  // Declutter with the masked rescue behind it keeps only CLASSIC_TRIES here:
  // the attempts beyond two were rescuing little (avg 2.3 to deliver), and the
  // rescue path spends that budget where it changes the outcome.
  // One more when the last render is worth finishing (a chained edit, below):
  // e27 (5 Sep 2026) failed attempt 2 on a single wall smear, and the masked
  // rescue then spent 160s failing twice on the clutter it always leaves.
  // DECLUTTER_CHAIN_EXTRA=0 turns the extra attempt off.
  const CHAIN_EXTRA = process.env.DECLUTTER_CHAIN_EXTRA === '0' ? 0 : 1;
  const classicCap = (type === 'staging' || (isRemovalJob && removalCandidates > 1)) ? 0
    : (type === 'declutter' && MASKED_DECLUTTER) ? Math.min(CLASSIC_TRIES, MAX_ATTEMPTS)
    : MAX_ATTEMPTS;
  // `!delivered`: since the coverage router (2 Sep 2026) a masked lead can
  // deliver BEFORE this loop — without the guard, classic kept generating
  // after the win and a passing whole-frame render would overwrite the
  // masked composite the customer was already promised.
  // Segmentation beside the generation (5 Sep 2026): when classic leads, the
  // close-up review and the masked rescue both need the clutter regions, and
  // neither should wait for them after the render. Paid once, like the router's.
  /**
   * THE CHAINED RETRY (5 Sep 2026). When a declutter attempt fails ONLY for
   * items left behind — the number-one failure on the 4 Sep bench — the next
   * attempt no longer starts over from the original and hopes the model
   * clears everything at once. It takes the attempt that was 90% there as its
   * input and asks for exactly the leftovers the judge named, nothing else.
   * A structural, furniture, camera or colour complaint still restarts from
   * the original, because those renders are not worth building on. A GHOST
   * does chain (5 Sep 2026): the trace of a dustpan on e02's floor was erased
   * cleanly by a 30s edit of the same render, where a fresh start left a jar
   * instead — the residue rule below asks for the surface to be rebuilt.
   * Every chained result is judged against the ORIGINAL like any other.
   * DECLUTTER_CHAIN_RETRY=0 restores start-over retries.
   */
  const CHAIN_RETRY = type === 'declutter' && process.env.DECLUTTER_CHAIN_RETRY !== '0';
  const LEFTOVER_ONLY = /\b(remain|remains|remaining|remnant|left behind|left in|left on|left un|leftover|still (visible|present|there|sits|sitting)|unremoved|not removed|partly|were not removed|was not removed|ghost|half-erased|smear|smudge|smudged|residue|outline|mottled)\b/i;
  const NOT_LEFTOVER = /\b(redrawn|seen through|removed|missing|relocated|moved|added|introduced|replaced|camera|framing|angle|architect\w*|structur\w*|flooring|finish|exposure|exposed differently|lit differently|colou?r|brightness|warped|distorted)\b/i;
  let chain = null;   // { data, mime, items[] } — the previous candidate to build on
  const leftoverOnly = (viol) => viol.length > 0 && viol.every(v => LEFTOVER_ONLY.test(v) && !NOT_LEFTOVER.test(v.replace(/\[[a-z_]+\]\s*/i, '').replace(/left behind|left in|left on|left un/gi, 'LEFT')));
  const chainPrompt = (items) => `${PRESERVATION}

TRANSFORMATION: FINISH A DECLUTTER.

This photograph has ALREADY been decluttered. It is nearly finished. An inspector found the traces below still in it — a leftover item, or the ghost of one: a smear, an outline, a half-erased shape, a smudged patch where something used to stand. Erase EXACTLY these traces — completely, including their shadows and any cable that belongs to them alone — and rebuild the clean, plausible surface (floor, wall, counter, shelf) that belongs there, matching the surrounding material and light exactly:
${items.map(i => '- ' + i).join('\n')}

Change NOTHING else. Every other pixel of this photograph is already correct: same furniture in the same places, same walls, floor, windows, fixtures, wall art, mirrors, light, exposure, framing. Do not tidy, restyle, add, move or redraw anything that is not on the list. Output this same photograph with only the listed traces gone.`;
  const segPromise = (type === 'declutter' && MASKED_DECLUTTER && !maskedSeg && classicCap > 0 && !delivered)
    ? segmentClutter().catch(e => { console.error('  segmentation (early) failed: ' + e.message.slice(0, 100)); return null; })
    : null;
  for (let attempt = 1; attempt <= classicCap + (chain ? CHAIN_EXTRA : 0) && !delivered; attempt++) {
    // Time check before a RETRY, never before the first attempt — a job that
    // has not generated anything yet has nothing to show for stopping.
    if (attempt > 1 && elapsed() + ATTEMPT_COST_S > jobBudgetS) {
      console.log(`\n— Out of time: ${elapsed().toFixed(0)}s spent of a ${jobBudgetS}s budget, ` +
        `and another attempt needs about ${ATTEMPT_COST_S}s. Stopping here rather than making them wait.`);
      audit.stoppedForTime = { elapsedSeconds: +elapsed().toFixed(1), budgetSeconds: jobBudgetS, afterAttempts: attempt - 1 };
      break;
    }
    console.log(`\n— Attempt ${attempt}/${MAX_ATTEMPTS}: generating (${type}${options.style ? ' · ' + options.style : ''})…`);
    const t0 = Date.now();
    let gen;
    const chained = !!chain;
    if (chained) console.log(`  chained: editing attempt ${attempt - 1}'s result for ${chain.items.length} leftover(s) — ${chain.items.map(i => i.slice(0, 50)).join('; ')}`);
    try {
      gen = chained
        ? await generateImage(apiKey, chainPrompt(chain.items), chain.data, chain.mime, { imageSize: IMAGE_SIZE, references })
        : await generateImage(apiKey, prompt, stageInputB64, stageInputMime, { imageSize: IMAGE_SIZE, references });
    } catch (e) {
      console.error('  generation error:', e.message);
      audit.attempts.push({ attempt, stage: 'generate', error: e.message });
      // Google being unavailable is not something a fourth try fixes.
      const outages = audit.attempts.filter(a => a.stage === 'generate' && UPSTREAM_DOWN.test(a.error || ''));
      if (outages.length >= UPSTREAM_STRIKES) {
        console.log(`— Google's image model has refused ${outages.length} attempts in a row. ` +
          'Stopping rather than repeating the same request.');
        audit.upstreamDown = { attempts: outages.length, lastError: String(e.message).slice(0, 300) };
        break;
      }
      continue;
    }
    const genMs = Date.now() - t0;
    const colourRecord = await normaliseRender(gen, originalBuf, type, `attempt${attempt}`, audit);
    // PIXEL GUARD (bench-gated) — see pixelguard.js.
    if (process.env.PIXEL_GUARD !== '0' && (options.fixedElements || []).length) {
      try {
        const pg = await pixelGuard(sharp, originalBuf, gen, options.fixedElements);
        gen.data = pg.data; gen.mime_type = pg.mime_type; gen.pixelGuard = pg.stats;
        audit.pixelGuard = (audit.pixelGuard || []).concat([{ label: `attempt${attempt}`, ...pg.stats }]);
        console.log(`  pixel guard snapped ${pg.stats.snappedPct}% across ${pg.stats.features} feature(s)`);
      } catch (e) { console.error('  pixel guard failed (raw candidate used): ' + e.message.slice(0, 100)); }
    }

    // The reconciler was removed 27 Aug 2026 (Kyle): it put clutter back when the
    // clutter sat on furniture, and the A/B showed declutter recovered better
    // without it (9/22 vs 4/22). Declutter's keeper rules live in the PROMPT now,
    // not in a post-hoc revert pass. The raw render goes straight to the checks.

    const rawExt = /png/i.test(gen.mime_type) ? 'png' : 'jpg';
    const rawPath = path.join(OUT_DIR, `${stem}.${tag}.attempt${attempt}.raw.${rawExt}`);
    fs.writeFileSync(rawPath, Buffer.from(gen.data, 'base64'));
    console.log(`  generated in ${(genMs / 1000).toFixed(1)}s → ${rawPath}`); lap(`gen${attempt}`);

    /**
     * EVERY check on this frame, at once.
     *
     * They all look at the same before/after pair and not one of them needs
     * another's answer: the compliance judge, the per-element structural check,
     * "was anything actually removed", and the two declutter-scope checks. They
     * were sequential only because each was gated on the previous verdict, which
     * saves a few cents on an attempt that was going to fail and costs 35 seconds
     * on every attempt that succeeds. Measured against the real models:
     *
     *   judge 18.2s + structure 7.7s + removal 11.3s + scope 21.5s  = 58.7s
     *   all of them together                                        = ~22s
     *
     * The gates themselves are unchanged — a violation from any of them still
     * fails the attempt and still goes back to the generator as feedback. Only
     * the waiting is gone.
     */
    console.log('  checking (one judge + instruments)…');
    /**
     * THE TEARDOWN (2 Sep 2026, Kyle: "rip all these judges out down to the
     * originals and give better prompts"). This block ran five model checks
     * per attempt — jury, structure verifier, removal verifier, clutter-left
     * verifier, then the phantom vetter over the jury's own claims — and the
     * golden set scored the pile 44/61, unchanged in a week. ONE judge
     * remains (its checklist in compliance.js absorbed the others'
     * questions); colour lock, pixel guard and the watermark verify stay
     * because arithmetic has never hallucinated. Twilight keeps its quality
     * score — a chooser consulted only on passes, part of the original spine.
     */
    /**
     * THE FRAME LOCK (2 Sep 2026). Kyle graded the day's 21 twilights and
     * five delivered ones were the same house RE-IMAGINED from a different
     * camera — and the judge's "always MAJOR — check first" camera rule had
     * passed every one, two votes each. Arithmetic now goes first: edge-map
     * alignment between original and candidate (framelock.js), tuned on his
     * graded pairs (reframes 0.19–0.33, honest relights 0.53–0.81, gate at
     * 0.42). A re-imagined frame dies here, before a cent of judging.
     */
    let flRecord = null;
    if (type === 'twilight') {
      try {
        flRecord = await frameLock(Buffer.from(originalB64, 'base64'), Buffer.from(gen.data, 'base64'));
      } catch (e) {
        console.error('  frame lock error (non-fatal):', e.message.slice(0, 120));
      }
      if (flRecord && !flRecord.ok) {
        console.log(`  FRAME LOCK FAIL — edge alignment ${flRecord.score} < ${flRecord.min}: the candidate is a different photograph of the property`);
        audit.attempts.push({ attempt, genMs, raw: rawPath, stage: 'framelock', framelock: flRecord });
        lap(`framelock${attempt}`);
        continue;
      }
    }

    const checksT0 = Date.now();
    /**
     * THE REVIEW RUNS BESIDE THE JUDGE, NOT AFTER IT (5 Sep 2026). On a classic
     * declutter the close-up review used to wait for the verdict, then segment
     * (if masked had not led), then review — 25–35s of serial wall time on
     * every passing candidate, measured on the 4 Sep bench. Both only need the
     * original, the candidate and the region boxes, so they now run together;
     * segmentation was started beside the generation for the same reason. A
     * review bought for a candidate the judge then fails costs pennies.
     */
    const reviewEarly = (type === 'declutter' && process.env.REGION_REVIEW !== '0' && MASKED_DECLUTTER)
      ? (async () => {
          if (!maskedSeg) maskedSeg = segPromise ? await segPromise : await segmentClutter();
          const regions = (maskedSeg && maskedSeg.regions || []).filter(r => Array.isArray(r.box_2d));
          if (!regions.length) return null;
          return reviewRegions(apiKey, JUDGE_MODEL, originalBuf, Buffer.from(gen.data, 'base64'), regions);
        })().catch(e => ({ error: e.message }))
      : Promise.resolve(null);
    // The view through the openings (see regionreview.reviewOpenings) — one
    // close-up call beside the judge, only when the catalogue found openings.
    const openingsEarly = (type === 'declutter' && process.env.OPENING_REVIEW !== '0' && (options.fixedElements || []).length)
      ? reviewOpenings(apiKey, JUDGE_MODEL, originalBuf, Buffer.from(gen.data, 'base64'), options.fixedElements).catch(e => ({ error: e.message }))
      : Promise.resolve(null);
    let [judged, quality] = await Promise.all([
      judgeComplianceVoted(apiKey, type, originalB64, mime, gen.data, gen.mime_type, JUDGE_MODEL, options.inventory, JUDGE_VOTES)
        .then(v => ({ ok: true, v }), e => ({ ok: false, e })),
      type === 'twilight'
        ? scoreCandidate(apiKey, JUDGE_MODEL, originalB64, mime, gen, type)
            .catch(e => ({ score: null, reason: 'quality reviewer unavailable: ' + e.message }))
        : Promise.resolve(null),
    ]);

    // A judge outage must never crash the run (the generation is already paid for)
    // and must never deliver unjudged output — treat it as a failed attempt.
    if (!judged.ok) {
      console.error('  judge error:', judged.e.message.slice(0, 200));
      audit.attempts.push({ attempt, genMs, raw: rawPath, stage: 'judge', error: judged.e.message });
      continue;
    }
    const verdict = judged.v;

    const colourFault = colourViolation(colourRecord);
    if (colourFault) {
      verdict.pass = false;
      verdict.violations = (verdict.violations || []).concat([colourFault]);
      console.log(`  COLOUR FAIL — ${colourFault}`);
    }

    if (verdict.pass) {
      const gone = await applianceRollCall(gen, `attempt ${attempt}`);
      if (gone.length) { verdict.pass = false; verdict.violations = (verdict.violations || []).concat(gone); }
    }
    /**
     * THE CLOSE-UP REVIEW ON CLASSIC DELIVERIES TOO (the owner's grade, 4 Sep
     * 2026). A whole-frame declutter shipped with a smeared door edge where
     * the bags had stood — and it had never been reviewed up close, because
     * the review only ran on masked composites. A classic render edits every
     * clutter region at once, so every catalogued region is a removal site
     * here. Same review, same fatal-only-on-residue rule; the segmentation is
     * the router's, paid once.
     */
    let classicReview = null;
    if (verdict.pass && type === 'declutter' && process.env.REGION_REVIEW !== '0') {
      try {
        classicReview = await reviewEarly;
        if (classicReview && classicReview.error) { console.error('  region review unavailable (non-fatal): ' + String(classicReview.error).slice(0, 100)); classicReview = null; }
        if (classicReview) {
          if (!classicReview.ok) {
            verdict.pass = false;
            verdict.violations = (verdict.violations || []).concat(classicReview.residue.map(t => `Residue left behind at close range — ${t}`));
            console.log(`  REGION REVIEW FAIL — ${classicReview.residue.length} region(s) show residue`);
            classicReview.residue.forEach(t => console.log('    ✗ ' + t));
          } else {
            console.log(`  region review clean (${classicReview.verdicts.length} regions)`);
          }
        }
      } catch (e) { console.error('  region review unavailable (non-fatal): ' + e.message.slice(0, 100)); }
    }

    let openingsReview = null;
    if (verdict.pass && type === 'declutter') {
      openingsReview = await openingsEarly;
      if (openingsReview && openingsReview.error) { console.error('  opening review unavailable (non-fatal): ' + String(openingsReview.error).slice(0, 100)); openingsReview = null; }
      if (openingsReview && !openingsReview.ok) {
        verdict.pass = false;
        verdict.violations = (verdict.violations || []).concat(openingsReview.changed.map(t => `The space seen through the ${t} — redrawn, not decluttered. Reproduce that opening and everything seen through it EXACTLY as in the original photograph; it is part of the building.`));
        console.log(`  OPENING REVIEW FAIL — ${openingsReview.changed.length} opening(s) show a different space beyond`);
        openingsReview.changed.forEach(t => console.log('    ✗ ' + t));
      } else if (openingsReview && !openingsReview.skipped) {
        console.log(`  openings unchanged (${openingsReview.verdicts.length} looked through)`);
      }
    }

    const rem = null;
    audit.attempts.push({ attempt, genMs, raw: rawPath, verdict, colour: colourRecord && colourRecord.colour, removal: rem, framelock: flRecord, review: classicReview, openings: openingsReview, chained });
    T.meter.phases.push({ name: `checks${attempt}`, ms: Date.now() - checksT0, atMs: checksT0 - T.start });
    lap(`judge${attempt}`);
    console.log(`  verdict: ${verdict.pass ? 'PASS' : 'FAIL'} (${verdict.passes}/${verdict.votes} votes pass, confidence ${verdict.confidence})`);
    if (verdict.violations.length) verdict.violations.forEach(v => console.log('    ✗ ' + v));
    if (verdict.minor && verdict.minor.length) verdict.minor.forEach(v => console.log('    ~ minor: ' + v));
    if (verdict.notes) console.log('    ' + verdict.notes);

    if (verdict.pass && type === 'twilight' && quality) {
      const q = quality;
      audit.attempts[audit.attempts.length - 1].quality = q;
      /**
       * THE UGLY FLOOR (Kyle's call, 2 Sep 2026). He graded every twilight of
       * the day: the ones he failed as ugly scored 1–4; every twilight he has
       * ever passed scores 8–9. Below TWILIGHT_SCORE_FLOOR the candidate is
       * retried, not delivered. Narrow by design: twilight only — the staging
       * design score measured anti-correlated with his taste and stays
       * advisory. (The score once hallucinated a camera claim to kill a good
       * twilight — but the frame lock owns camera questions now, so a low
       * score here is only ever about the light.)
       */
      const floor = parseFloat(process.env.TWILIGHT_SCORE_FLOOR || '5');
      if (q.score !== null && q.score < floor) {
        verdict.pass = false;
        verdict.violations = (verdict.violations || []).concat([`twilight quality ${q.score}/10 is below the floor of ${floor} — retrying for a better roll`]);
        console.log(`  QUALITY FLOOR — score ${q.score} < ${floor}: rejected, retrying`);
      } else {
        console.log(`  quality score: ${q.score} — ${q.reason}`);
      }
    }

    if (verdict.pass) {
      /**
       * Declutter has a definition now, and it is checked in both directions:
       * clutter still in the frame (Kyle's trash can), and furnishings taken
       * that were meant to stay (the towels and the vase, the run after).
       * `empty` skips this — there, everything movable going is the job.
       *
       * The "still there" half already ran alongside the compliance checks
       * above. Only the "took too much" half has to wait, because it reads the
       * list of what the removal check says actually went.
       */
      // (Scope re-checks at delivery: removed in the teardown, 2 Sep 2026 —
      // the one judge's checklist carries clutter-gone and took-too-much now.)
      const wmText = WATERMARK_TEXT[type];
      let finalBuf;
      if (wmText) {
        console.log('  applying disclosure watermark…');
        const preWmBuf = Buffer.from(gen.data, 'base64');
        finalBuf = await applyWatermark(preWmBuf, wmText);
        const wmCheck = await verifyWatermark(finalBuf, wmText, preWmBuf);
        if (!wmCheck.present) {
          console.error('  watermark verification FAILED — not delivering this attempt');
          audit.attempts[audit.attempts.length - 1].watermark = wmCheck;
          continue;
        }
        audit.watermark = { text: wmText, ...wmCheck };
      } else {
        console.log('  no disclosure required for this transformation — delivering clean');
        finalBuf = Buffer.from(gen.data, 'base64');
        audit.watermark = { text: null, required: false };
      }
      const outPath = path.join(OUT_DIR, `${stem}.${tag}.approved.jpg`);
      fs.writeFileSync(outPath, finalBuf);
      // The clean frame for chained edits (see the staging delivery site).
      if (wmText) fs.writeFileSync(outPath.replace(/\.approved\.jpg$/, '.approved.clean.jpg'), Buffer.from(gen.data, 'base64'));
      delivered = outPath;
      audit.delivered = outPath;
      break;
    }

    // Rejected on compliance, structure, colour, removal or quality. Until this
    // line existed, the next attempt was sent the identical prompt.
    if (prepareRetry(verdict)) break;
    // Leftovers only → build on this render; anything else → start over.
    const majors = (verdict.violations || []).map(v => String(v));
    const items = majors.map(v => v.replace(/^\[[a-z_]+\]\s*/i, '').replace(/^\[checklist\]\s*(still|partly):\s*/i, '').trim());
    chain = (CHAIN_RETRY && leftoverOnly(majors)) ? { data: gen.data, mime: gen.mime_type, items: [...new Set(items)].slice(0, 8) } : null;
  }

  // ---- The masked rescue: classic failed, so the furniture-preserving path
  // takes over — seeded with classic's paid renders. Not run when the model
  // itself is down (nothing to rescue with), the job never generated, or the
  // coverage router already let masked lead (its rounds are spent).
  if (type === 'declutter' && MASKED_DECLUTTER && !delivered && !audit.upstreamDown && !maskedLed) {
    console.log('\n— Classic declutter did not deliver; masked rescue takes the job.');
    // The rescue starts where classic stopped, so it gets its own clock —
    // both the local budget checks and the HTTP client's shared deadline.
    setDeadline(clampToKill(JOB_START, JOB_START + (JOB_BUDGET_S + MASKED_EXTRA_S + JOB_DEADLINE_GRACE_S) * 1000));
    // The router may have segmented already (and found nothing, or routed to
    // classic) — never pay for segmentation twice.
    await runMasked(maskedSeg || (segPromise && await segPromise) || await segmentClutter(), { budgetS: JOB_BUDGET_S + MASKED_EXTRA_S, rounds: MASKED_ROUNDS });
  }

  audit.finishedAt = new Date().toISOString();
  // Two clocks, because they answer different questions. `totalSeconds` is the
  // generate-and-check loop, which is what tuning changes. `jobSeconds` is what
  // the agent actually sat and waited for, setup reads included — the only one
  // that matters to the person watching the spinner, and the one the budget
  // above is measured against.
  audit.timing = {
    totalSeconds: +((Date.now() - T.start) / 1000).toFixed(1),
    jobSeconds: +elapsed().toFixed(1),
    budgetSeconds: jobBudgetS,
    cumulative: T.stages,
  };
  // What it spent, where the seconds went, which door served it, what failed.
  audit.spend = meter.summarise(T.meter, { imageSize: IMAGE_SIZE });
  console.log('\nTiming (cumulative): ' + JSON.stringify(T.stages) +
    `  loop ${audit.timing.totalSeconds}s · whole job ${audit.timing.jobSeconds}s of ${jobBudgetS}s`);
  // "Rejected" and "never ran" are different things and must not be told to the
  // customer in the same words. On 26 Aug 2026 Google's image model was returning
  // 500/503 ("gemini-3-pro-image is currently unavailable"), every attempt died
  // before producing a frame, and the app told Kyle "no result passed our
  // compliance checks" — blaming a judge for an outage. Credits come back either
  // way; the sentence should still be true.
  const generationFailures = audit.attempts.filter(a => a.stage === 'generate' && a.error);
  const neverGenerated = !delivered && audit.attempts.length > 0 &&
    generationFailures.length === audit.attempts.length;
  audit.outcome = delivered ? 'approved' : neverGenerated ? 'error' : 'rejected';
  if (neverGenerated) audit.errorSummary = String(generationFailures.at(-1).error).slice(0, 300);
  audit.creditCharged = delivered ? true : false; // rejected runs refund automatically
  const auditPath = path.join(OUT_DIR, `${stem}.${tag}.audit.json`);
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));

  console.log('\n════════════════════════════════════');
  if (delivered) {
    console.log(`APPROVED → ${delivered}`);
  } else if (neverGenerated) {
    console.log(`UNAVAILABLE — no attempt produced an image: ${audit.errorSummary}`);
    console.log('The original photograph is unchanged. Credit would be restored.');
  } else {
    console.log(audit.stoppedForTime
      ? `REJECTED — out of time after ${audit.stoppedForTime.afterAttempts} attempt(s) (${audit.stoppedForTime.elapsedSeconds}s).`
      : 'REJECTED — no compliant result within attempt budget.');
    console.log('The original photograph is unchanged. Credit would be restored.');
  }
  console.log(`Audit record → ${auditPath}`);
}

// Run as a CLI when invoked directly; stay importable (no side effects) when
// required, so the model-fallback logic can be behaviourally tested with fake
// doors instead of waiting for a real Google outage.
if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

module.exports = { generateImage, generateViaDoors, _setDoors, MODEL_DOWN, FALLBACK_MODEL, FALLBACK_COLOUR };
