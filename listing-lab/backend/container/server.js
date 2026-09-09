/**
 * Listing Lab — the pipeline container.
 *
 * This is a thin harness around the EXISTING pipeline. It does not import it,
 * refactor it, or reimplement any of it: it writes the photo to a file, runs
 *
 *     node transform.js --input <file> --type <type> [--style …] [--room …]
 *
 * as a subprocess, and reads back what that produces. Byte for byte the same code
 * that produced every render Kyle has graded.
 *
 * WHY A SUBPROCESS RATHER THAN AN IMPORT
 * `transform.js` is a command-line program — it reads process.argv, writes into
 * out/, and exits. Turning it into a library means editing the file that is the
 * product, and the structural checker's crop geometry is exactly the thing that
 * must not be disturbed. A subprocess costs a few milliseconds and changes
 * nothing.
 *
 * WHY THIS RUNS IN A CONTAINER AT ALL
 * The pipeline needs `sharp` for every crop, resize and watermark. It is a
 * compiled binary; Cloudflare Workers run JavaScript only. So the Worker handles
 * accounts, credits and the API, and hands the image work here.
 *
 * ONE RUN = ONE CREDIT. transform.js does its own retrying inside — up to three
 * generation attempts for staging, and it gives up if none of them pass. So a
 * single invocation is exactly what a credit buys, and a "rejected" result is the
 * signal for the Worker to put the credits back.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
// The pipeline is CommonJS and lives beside this file in the image (/app/pipeline).
const requireCjs = createRequire(import.meta.url);
let uprightInput;
try { ({ uprightInput } = requireCjs('./pipeline/orient.js')); }            // in the image: /app/pipeline
catch { ({ uprightInput } = requireCjs('../pipeline/orient.js')); }         // in the repo: backend/pipeline

const PIPELINE_DIR = process.env.PIPELINE_DIR || '/app/pipeline';
const PORT = Number(process.env.PORT || 8080);
/**
 * The last line of defence, and nothing more.
 *
 * The pipeline now polices its own clock: a 240-second attempt budget plus 120
 * seconds of grace for checks already in flight, so a job that behaves finishes
 * inside six minutes and normally inside two or three. This exists for the job
 * that does NOT behave — a wedged socket, a child that never exits — because a
 * hung process holds a container slot, and a held slot is a customer whose job
 * never starts at all.
 *
 * Ten minutes: comfortably past anything legitimate, far short of the fifteen
 * it used to be, which was long enough for a stuck job to look like a working
 * one for a very long time.
 */
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 10 * 60 * 1000);

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * HOW MANY JOBS THIS INSTANCE WILL RUN AT ONCE.
 *
 * It used to be "all of them". `/run` answered 202 and fired `handleRun` without
 * looking at what was already in flight, which is fine for one photographer
 * uploading one photo and wrong the first busy afternoon.
 *
 * Kyle asked the right question: three agents, five virtual stagings each, all
 * at once. Fifteen jobs land, hash across four container slots, and each
 * instance would start four `node transform.js` processes — each of which fires
 * three staging candidates. Two things break, and neither is theoretical:
 *
 *   MEMORY  Every process holds a full frame and its crops in sharp at once.
 *           A single 50MP frame walked through sharp twice already killed a
 *           container once (Round 31). Four at a time on one instance is an
 *           out-of-memory kill dressed up as a mysterious failure.
 *   RATE    Four jobs x three candidates is a dozen image requests from one
 *           instance in a few seconds, times four instances. That is a 429
 *           storm we inflict on ourselves.
 *
 * Two at a time, and anything else is REFUSED rather than queued in memory here.
 * Refusing is the better half: a job held in this process disappears if the
 * instance is recycled, whereas a refused one goes back to the Worker's retry
 * queue — which is durable, visible in the database, and already the thing that
 * survives outages and deploys. Reuse the machinery that is known to work.
 */
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 2);
let inFlight = 0;

/**
 * "Google is busy", as opposed to "this photograph is a problem".
 *
 * Google's image model answers a plain 500 when its shared pool is saturated —
 * "gemini-3-pro-image is currently experiencing high demand" — which is not our
 * quota, not our key, and not the customer's photo. It is the same class of
 * thing as a 503 or the old 524, and the Worker treats jobs that die on it
 * completely differently: they wait and try again rather than failing.
 *
 * Kept deliberately in step with UPSTREAM_DOWN in pipeline/transform.js. A test
 * holds both to Google's actual wording.
 */
const UPSTREAM_DOWN = /\b(500|502|503|504|524|429)\b|UNAVAILABLE|high demand|overloaded|timed out|ran out of time/i;

/**
 * "Try this again" as opposed to "this photo cannot be done".
 *
 * Wider than UPSTREAM_DOWN on purpose, because Google being busy is not the only
 * thing that is nobody's fault and fixes itself:
 *
 *   pipeline exited null   The process was KILLED — no exit code, just gone.
 *                          Cloudflare cycling instances during a deploy does
 *                          exactly this, and it happened live on 26 Aug 2026:
 *                          a twilight died four words into "Building structure
 *                          manifest" because a new image rolled out underneath
 *                          it. The customer was told their photo had a problem.
 *                          It did not. It never even got looked at.
 *   fetch failures         The original could not be read, the callback could
 *                          not be posted: transport, not content.
 *
 * Everything here parks the job for the retry queue instead of failing it. What
 * is deliberately NOT here: a bad option, a refusal, a compliance rejection, an
 * unreadable image. Those will fail identically in ninety seconds, and retrying
 * them twenty times spends the customer's day proving it.
 */
const RETRYABLE = new RegExp(UPSTREAM_DOWN.source +
  '|pipeline exited null|SIGKILL|SIGTERM|killed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed' +
  // A verdict-less exit is a silent crash — most often the process dying
  // without a word (an out-of-memory kill on a huge original leaves no
  // stdout). Two of Kyle's 1 Sep batch hard-failed this way in minutes. A
  // fresh container often survives the same photo; if it never does, the
  // give-up ceiling still ends the job with the credits back.
  '|finished without printing a verdict' +
  '|run interrupted|not enough time left to generate', 'i');

/**
 * Run the pipeline once.
 * Returns { outcome: 'delivered'|'rejected', imagePath, audit, stdout }.
 */
async function runPipeline({ workDir, inputPath, transformation, style, roomType, notes }) {
  const args = ['transform.js', '--input', inputPath, '--type', transformation];
  if (style) args.push('--style', style);
  if (roomType) args.push('--room', roomType);
  if (notes) args.push('--notes', notes);

  log('running', args.join(' '));

  const child = spawn('node', args, {
    cwd: PIPELINE_DIR,
    env: {
      ...process.env,
      // The render size is chosen per photograph by the pipeline now: anything
      // generated above the upload's own size is discarded on the way out, so a
      // 2048px upload rendered at 4K costs nearly double and delivers the same
      // file. Forcing 4K here overrode that choice on every job. An explicit
      // IMAGE_SIZE in the container's environment still wins, for experiments.
      ...(process.env.IMAGE_SIZE ? { IMAGE_SIZE: process.env.IMAGE_SIZE } : {}),
      // The pipeline clamps its own deadline inside this kill setting, so it
      // always concludes (deliver / reject / outage) before the SIGKILL lands.
      RUN_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
      // Each job writes into its own directory so two concurrent jobs on the same
      // photo cannot read each other's output.
      OUT_DIR: workDir,
    },
  });

  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
  child.stderr.on('data', d => { stderr += d; process.stderr.write(d); });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pipeline exceeded ${RUN_TIMEOUT_MS}ms and was killed`));
    }, RUN_TIMEOUT_MS);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', c => { clearTimeout(timer); resolve(c); });
  });

  if (code !== 0) {
    throw new Error(`pipeline exited ${code}: ${(stderr || stdout).slice(-400)}`);
  }

  // transform.js announces its verdict on stdout and writes the files alongside.
  const approved = stdout.match(/APPROVED → (.+)/);
  const auditMatch = stdout.match(/Audit record → (.+)/);
  const audit = auditMatch ? await readJsonSafe(auditMatch[1].trim()) : null;

  if (approved) {
    // Extra passing versions (staging ships up to two runners-up that cleared
    // the same checks as the winner — "Version 2"/"Version 3" to the customer).
    const extraPaths = [...stdout.matchAll(/APPROVED-EXTRA → (.+)/g)].map(m => m[1].trim());
    return { outcome: 'delivered', imagePath: approved[1].trim(), extraPaths, audit, stdout };
  }
  // An outage is not a rejection. When the image service refused every attempt,
  // the customer must not be told their photo failed a compliance check.
  if (/^UNAVAILABLE — /m.test(stdout)) {
    return {
      outcome: 'error', imagePath: null, audit, stdout,
      error: audit?.errorSummary || (stdout.match(/^UNAVAILABLE — (.*)$/m) || [])[1] || 'the image service was unavailable',
    };
  }
  /**
   * "There is nothing here to do" is not a rejection.
   *
   * A declutter on a room with no clutter has no honest output, and the pipeline
   * now says so after the catalogue rather than after five generations. The
   * customer must not be told their photo failed compliance checks — nothing was
   * checked, because nothing was made. Credit back either way; the sentence
   * should still be true.
   */
  if (/^NOT APPLICABLE — /m.test(stdout)) {
    return {
      outcome: 'rejected', imagePath: null, audit, stdout, notApplicable: true,
      error: (stdout.match(/^NOT APPLICABLE — (.*)$/m) || [])[1] || 'nothing to do on this photo',
    };
  }
  if (/REJECTED/.test(stdout)) {
    /**
     * Send back WHAT IT PRODUCED, even though we are not delivering it.
     *
     * A rejected attempt used to live and die inside this container: the frame
     * was written to a temp directory and the directory was deleted. So when a
     * job came back "nothing passed the checks", nobody — not the customer, not
     * Kyle, not me — could ever look at what it actually made or judge whether
     * the checks were being reasonable.
     *
     * That is tolerable while the checks are trusted and fatal the moment you
     * want to measure them. Kyle is about to grade sixty photographs, and half
     * the information in that exercise is in the REJECTIONS: the ones he would
     * have shipped and we refused are the ones costing him money.
     *
     * The last attempt is the right one to keep. It is the one the retry loop
     * ended on, having been told what was wrong with all the ones before it.
     */
    const last = [...(audit?.attempts || [])].reverse().find(a => a && a.raw);
    let rejectedImage = null;
    if (last) {
      rejectedImage = await readFile(last.raw)
        .then(b => ({ filename: basename(last.raw), base64: b.toString('base64') }))
        .catch(err => { log('could not read the rejected frame', err.message); return null; });
    }
    return { outcome: 'rejected', imagePath: null, audit, stdout, rejectedImage };
  }
  // Neither verdict printed. Treat as an error rather than guessing — a job that
  // silently reports "delivered" with no image is worse than one that fails.
  throw new Error('pipeline finished without printing a verdict');
}

async function readJsonSafe(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

/**
 * Report back to the Worker. The container never touches R2 or the database — it
 * hands the bytes back and the Worker decides what to store and whether to return
 * the customer's credits.
 */
async function reportResult(job, body) {
  // Retry the callback (reliability review, 31 Aug 2026).
  //
  // The generation already cost real money and the bytes exist only in this
  // container's memory — the work directory is deleted the moment handleRun
  // returns. If this single POST failed (a transient Worker/D1 blip returning a
  // 5xx, or a dropped connection), the old code just logged and dropped the
  // result. The job then went silent, the reaper re-dispatched it 12 minutes
  // later, and Google was paid a SECOND time for an image we already had.
  //
  // So we retry with backoff before giving up. The Worker's callback is
  // idempotent (finishJob writes once, guarded by finished_at IS NULL), so a
  // duplicate delivery from a retry is harmless — far cheaper than a re-render.
  const payload = JSON.stringify(body);
  const MAX = 5;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const res = await fetch(job.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pipeline-secret': job.callbackSecret,
        },
        body: payload,
      });
      if (res.ok) return true;
      // 4xx is our own bug (bad secret, unknown job) — retrying won't help, and
      // the Worker has already decided. Only 5xx / network faults are transient.
      const text = (await res.text().catch(() => '')).slice(0, 200);
      if (res.status < 500) { log('callback refused (permanent)', res.status, text); return false; }
      lastErr = `${res.status} ${text}`;
    } catch (err) {
      lastErr = err?.message || String(err);
    }
    if (attempt < MAX) {
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)); // 0.5s,1s,2s,4s
      log(`callback attempt ${attempt}/${MAX} failed (${lastErr}); retrying in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  log('callback failed after retries — result may be lost, reaper will re-run', lastErr);
  return false;
}

/**
 * Can this container reach Google directly, today?
 *
 * On 25 Aug it could not — Google answered 400 FAILED_PRECONDITION, "User
 * location is not supported for the API use", which is why every call is routed
 * through the Worker instead. That detour is what imposes Cloudflare's
 * 125-second ceiling on generations, and the ceiling is what killed three of
 * Kyle's jobs. If the block is gone, the detour and the ceiling can both go.
 *
 * Asked with a deliberately invalid key, so nothing is spent and nothing leaks:
 *   "API key not valid"        → we are allowed here; only the key was wrong
 *   "location is not supported" → still blocked, the Worker must stay
 */
async function checkEgress() {
  const started = Date.now();
  const out = { at: new Date().toISOString() };
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': 'deliberately-invalid-key' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    const text = await res.text();
    out.status = res.status;
    out.ms = Date.now() - started;
    out.geoBlocked = /location is not supported/i.test(text);
    out.reachedGoogle = /API key not valid|API_KEY_INVALID|location is not supported/i.test(text);
    out.body = text.slice(0, 300);
  } catch (err) {
    out.ms = Date.now() - started;
    out.error = String(err && err.message).slice(0, 200);
  }
  /**
   * Is the container actually holding a working key?
   *
   * The check above deliberately uses an invalid one, because it is asking
   * "will Google talk to this address at all" and must never spend anything.
   * That leaves a real question unanswered: after moving the key out of the
   * Worker and into the container's own environment, does the container HAVE
   * it, and is it good? A key that is missing or wrong looks from the outside
   * exactly like an outage — and on the day this was written Google's image
   * model was down, so "the generation failed" proved nothing either way.
   *
   * `GET /models` answers it. It lists what the key can reach, costs nothing,
   * and returns no secret. Only the model count and the verdict come back here.
   */
  out.key = { present: !!process.env.GEMINI_API_KEY, viaWorker: !!process.env.GEMINI_BASE_URL };
  if (out.key.present) {
    try {
      const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
      const r = await fetch(`${base}/models`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
      const t = await r.text();
      out.key.status = r.status;
      out.key.works = r.ok;
      out.key.models = r.ok ? (JSON.parse(t).models || []).length : undefined;
      if (!r.ok) out.key.said = t.slice(0, 160);
      // And whether the image model is up right now, which is the difference
      // between "your photo failed" and "Google is busy".
      out.imageModel = await (async () => {
        const g = await fetch(`${base}/models/gemini-3-pro-image`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
        return { status: g.status, listed: g.ok };
      })().catch(e => ({ error: String(e && e.message).slice(0, 120) }));
    } catch (err) { out.key.error = String(err && err.message).slice(0, 160); }
  }
  // Where this container appears to be, which is the thing Google objects to.
  try {
    const r = await fetch('https://cloudflare.com/cdn-cgi/trace');
    const t = await r.text();
    out.egress = Object.fromEntries(t.trim().split('\n').map(l => l.split('=')).filter(p => ['ip','loc','colo'].includes(p[0])));
  } catch (err) { out.egressError = String(err && err.message).slice(0, 120); }
  return out;
}

async function handleRun(job) {
  const workDir = await mkdtemp(join(tmpdir(), `ll-${job.jobId}-`));
  // The pulse (1 Sep 2026): one beat now, one every 45 seconds while the run
  // is in flight. The Worker's sweep reads three minutes of silence from a
  // heartbeating container as "provably lost" and restarts the job — which
  // took 12 blind minutes before this existed (a 4-minute staging delivered
  // in 17). Fire-and-forget: a failed beat never disturbs the run.
  const hbUrl = job.callbackUrl.replace(/\/result$/, '/heartbeat');
  const beat = () => fetch(hbUrl, {
    method: 'POST', headers: { 'x-pipeline-secret': job.callbackSecret },
  }).catch(() => {});
  beat();
  const hbTimer = setInterval(beat, 45_000);
  try {
    const res = await fetch(job.originalUrl);
    if (!res.ok) throw new Error(`could not fetch the original photo: ${res.status}`);
    const ext = (res.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg';
    const inputPath = join(workDir, `original.${ext}`);
    await writeFile(inputPath, Buffer.from(await res.arrayBuffer()));

    const out = await runPipeline({ workDir, inputPath, ...job });

    // An outage is Google's, not the customer's, and the Worker needs to know
    // which it was: an outage means wait and try again, everything else means
    // finish the job. Saying so explicitly beats making the Worker re-read a
    // sentence written for a human.
    const outage = out.outcome === 'error' && UPSTREAM_DOWN.test(String(out.error || ''));
    const retryable = out.outcome === 'error' && RETRYABLE.test(String(out.error || ''));
    const payload = {
      jobId: job.jobId,
      outcome: out.outcome,
      upstreamDown: outage,
      retryable,
      attemptsUsed: out.audit?.attempts?.length ?? null,
      audit: out.audit,
      // The customer-facing reason, in their language rather than the log's.
      error: out.error || null,
      note: out.notApplicable
        ? 'This room already reads clean — there is no clutter here for us to remove, so nothing was changed and no credit was spent.'
        : out.outcome === 'rejected'
        ? 'No result passed our compliance checks, so nothing was delivered and your credits have been returned.'
        : out.outcome === 'error'
          ? outage
            ? 'The image service is busy right now. Your photo is still queued and we are trying again — nothing has been charged.'
            : retryable
              ? 'That run was interrupted on our side. Your photo is still queued and we are running it again — nothing has been charged.'
              : 'Something went wrong while producing this photo. Your credits have been returned.'
          : null,
      image: out.imagePath
        ? { filename: basename(out.imagePath), base64: (await readFile(out.imagePath)).toString('base64') }
        : null,
      // The pre-watermark frame, for chained edits ("Stage this room"). Read
      // defensively — an older pipeline build that wrote no clean copy must
      // never sink the delivery itself.
      cleanImage: await (async () => {
        if (!out.imagePath) return null;
        try {
          const cleanPath = out.imagePath.replace(/\.approved\.jpg$/, '.approved.clean.jpg');
          if (cleanPath === out.imagePath) return null;
          return { base64: (await readFile(cleanPath)).toString('base64') };
        } catch { return null; }
      })(),
      // Runner-up versions that also passed every check. Read defensively: a
      // missing file must never sink the delivery of the winner.
      extraImages: out.extraPaths?.length
        ? (await Promise.all(out.extraPaths.slice(0, 2).map(async p => {
            try { return { filename: basename(p), base64: (await readFile(p)).toString('base64') }; }
            catch { return null; }
          }))).filter(Boolean)
        : [],
      // What it made but we would not deliver. Kept for grading, never shown as
      // a result — see reject_key in the Worker.
      rejectedImage: out.rejectedImage || null,
    };
    await reportResult(job, payload);
    log(job.jobId, out.outcome);
  } catch (err) {
    log(job.jobId, 'FAILED', err.message);
    // The pipeline can die on an upstream outage before it ever reaches the
    // attempt loop — a 503 during the keep-list catalogue, say. Same cause as an
    // outage inside the loop, so it should read the same to the customer rather
    // than as "something went wrong with your photo".
    const upstreamDown = UPSTREAM_DOWN.test(String(err.message));
    const retryable = RETRYABLE.test(String(err.message));
    await reportResult(job, {
      jobId: job.jobId,
      outcome: 'error',
      upstreamDown,
      retryable,
      note: upstreamDown
        ? 'The image service is busy right now. Your photo is still queued and we are trying again — nothing has been charged.'
        : retryable
          ? 'That run was interrupted on our side. Your photo is still queued and we are running it again — nothing has been charged.'
          : 'Something went wrong while producing this photo. Your credits have been returned.',
      error: String(err.message).slice(0, 500),
    });
  } finally {
    clearInterval(hbTimer);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Classify a photograph so the app only offers transformations that make sense
 * for it.
 *
 * WHY THIS EXISTS
 * On 25 Aug 2026 the deployed app cheerfully ran DECLUTTER on an already-empty
 * great room. Nothing was removed, because there was nothing to remove — and the
 * result was delivered stamped "Virtually decluttered". That is a false
 * disclosure on an unmodified photograph, which is precisely the thing this
 * product exists to prevent. It also charged a credit for it.
 *
 * One cheap vision call at upload time closes it: an empty room is never offered
 * declutter or empty, a furnished room is never offered staging, and an exterior
 * is only offered twilight.
 */
async function classifyScene(imageUrl) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.JUDGE_MODEL || 'gemini-3.6-flash';
  if (!key) throw new Error('no GEMINI_API_KEY in the container');

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`could not fetch the photo: ${res.status}`);
  let bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error('the photo came back empty');
  // Sideways iPhone portraits confuse "is this a bedroom" as much as they
  // confuse the generator — same upright step as the pipeline (orient.js).
  try { const up = await uprightInput(bytes); if (up.oriented) bytes = up.buf; } catch {}
  const b64 = bytes.toString('base64');
  log('classifying', bytes.length, 'bytes');

  // Independent signals, not one bucket. A room with two boxes in it has
  // something to remove AND floor to furnish; a single label cannot say both,
  // and the first version's "empty room" wording swallowed exactly that case.
  const prompt = `Look at this real-estate photograph and answer four independent questions about it.

1. "isExterior": is this the outside of a building, or a garden, yard, driveway, street or pool?

2. "removableClutter": how much is there in this room that a seller would want tidied away before a showing — boxes, laundry, toiletries, cables, worktop appliances, toys, bins, personal effects, paperwork?
   - "none": genuinely nothing. A staged or professionally cleared room.
   - "some": a handful of items. Two boxes on the floor. A few things on a bathroom counter. This still counts as something to remove.
   - "lots": visibly cluttered or lived-in.

3. "furniture": how much real furniture is in the room?
   - "none": an empty room.
   - "sparse": a piece or two, with most of the floor still open.
   - "furnished": properly furnished.

4. "stageableFloor": is there a meaningful area of open floor that furniture could be placed on? true or false. A bathroom, a closet, a tight hallway or a detail shot is false.

Judge what is actually visible. Do not assume a tidy room is empty, and do not call a couple of boxes "none".

Respond with ONLY JSON:
{"isExterior":false,"removableClutter":"none|some|lots","furniture":"none|sparse|furnished","stageableFloor":true,"why":"a short phrase"}`;

  // Same route the pipeline uses — see gemini.js. Google refuses this container's
  // egress by location, so the request goes out through the Worker instead.
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
  const r = await fetch(`${base}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key || '' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
      generationConfig: { temperature: 0, response_mime_type: 'application/json' },
    }),
  });
  if (!r.ok) throw new Error(`classify failed: ${r.status} ${(await r.text()).replace(/\s+/g, ' ').slice(0, 500)}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
  let out = {};
  try { out = JSON.parse(text); } catch {}
  return {
    isExterior: out.isExterior === true,
    removableClutter: ['none', 'some', 'lots'].includes(out.removableClutter) ? out.removableClutter : null,
    furniture: ['none', 'sparse', 'furnished'].includes(out.furniture) ? out.furniture : null,
    stageableFloor: out.stageableFloor !== false,
    why: String(out.why || '').slice(0, 200),
  };
}

/**
 * THE CYCLE SIGNAL (2 Sep 2026, after the poisoned-slots incident). Four
 * container deploys in a day left some instances wedged between image
 * versions, and every job hashed to their slot died to the 15-minute
 * give-up. Now a deploy (or the owner) can POST /cycle to every slot: the
 * instance stops accepting new jobs, finishes what it is running, and exits
 * cleanly — the next request boots a FRESH instance on the current image.
 * No lingering half-version container can poison a slot again.
 */
let draining = false;
function exitIfDrained() {
  if (draining && inFlight === 0) {
    log('cycle: drained — exiting so the next request boots a fresh instance');
    // Give the log a beat to flush, then leave.
    setTimeout(() => process.exit(0), 250);
  }
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, draining, inFlight, pipeline: PIPELINE_DIR }));
  }

  if (req.method === 'POST' && req.url === '/cycle') {
    draining = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ draining: true, inFlight }));
    exitIfDrained();
    return;
  }

  // Read-only, spends nothing, returns no secret. See checkEgress.
  if (req.method === 'GET' && req.url === '/diag/egress') {
    checkEgress().then(out => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/classify') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { imageUrl } = JSON.parse(body);
        if (!imageUrl) throw new Error('imageUrl is required');
        const out = await classifyScene(imageUrl);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (err) {
        log('classify failed', err.message);
        // Never block an upload on this. An unknown scene offers everything,
        // which is the behaviour we had before this check existed.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ scene: 'unknown', error: String(err.message).slice(0, 600) }));
      }
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404).end('not found');
    return;
  }

  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let job;
    try { job = JSON.parse(body); }
    catch { res.writeHead(400).end('bad json'); return; }

    if (!job.jobId || !job.transformation || !job.originalUrl || !job.callbackUrl) {
      res.writeHead(400).end('missing fields');
      return;
    }

    // Draining for a cycle: refuse like a full instance — the Worker's
    // retry hops to another slot, and this instance exits when idle.
    if (draining) {
      log(job.jobId, 'refused: instance is draining for a cycle');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ busy: true, draining: true, jobId: job.jobId }));
      return;
    }

    // Full. Say so plainly and let the Worker put it back in the durable queue
    // rather than starting work this instance cannot finish well.
    if (inFlight >= MAX_CONCURRENT_JOBS) {
      log(job.jobId, `refused: ${inFlight} job(s) already running on this instance`);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ busy: true, inFlight, jobId: job.jobId }));
      return;
    }

    // Answer immediately. A staging job takes minutes and nothing upstream should
    // be holding a socket open that long — the Worker polls, the browser polls.
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, jobId: job.jobId }));

    inFlight++;
    handleRun(job)
      .catch(err => log('unhandled', err))
      .finally(() => { inFlight--; exitIfDrained(); });
  });
});

server.listen(PORT, () => log(`pipeline container listening on ${PORT}, pipeline at ${PIPELINE_DIR}`));
