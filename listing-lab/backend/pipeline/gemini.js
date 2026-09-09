/**
 * Listing Lab — Gemini API client (no SDK; plain fetch, same as the
 * eventual Cloudflare Worker). Two endpoints:
 *  - interactions:      image generation/editing with gemini-3-pro-image
 *  - generateContent:   the compliance judge (vision + JSON out)
 */
/**
 * Where Google's API lives — or, in production, where we reach it FROM.
 *
 * WHY THIS IS OVERRIDABLE
 * Google geolocates the caller and refuses whole regions outright:
 *
 *   400 FAILED_PRECONDITION — "User location is not supported for the API use."
 *
 * Cloudflare containers egress from addresses Google will not serve, so every
 * job died there while the identical request from the Cloudflare Worker returned
 * 200. Measured on 25 Aug 2026: worker OK, container refused, same key, same
 * account, same minute. Pinning the container's placement to North America did
 * not help — placement is not egress.
 *
 * So for a while the container pointed this at the Worker, which forwarded to
 * Google from an address Google accepts. That detour had a price nobody costed:
 * Cloudflare cuts a Worker's own outbound fetch at 125 seconds, so any
 * generation Google took longer than two minutes to produce died on our own
 * infrastructure. It killed three of Kyle's jobs on 26 Aug, a twilight among
 * them.
 *
 * Re-measured from inside the container on 26 Aug 2026 (/internal/diag/egress):
 * geoBlocked false, reachedGoogle true, egress ORD/US. The block is gone, so
 * the detour is gone and the ceiling with it. GEMINI_VIA_WORKER=1 in
 * wrangler.toml puts it back with one flip if Google ever reinstates the block.
 *
 * Unset, it talks to Google directly — exactly as it does on a laptop.
 */
const DIRECT = 'https://generativelanguage.googleapis.com/v1beta';
const BASE = process.env.GEMINI_BASE_URL || DIRECT;

/**
 * THE GEO-BLOCK, AND WHY THIS IS DECIDED AT RUNTIME RATHER THAN AT DEPLOY TIME
 *
 * Google refuses some callers by location outright:
 *
 *   400 FAILED_PRECONDITION — "User location is not supported for the API use."
 *
 * The mistake made twice already is treating that as a property of the DEPLOYMENT.
 * It is not. Cloudflare places container instances across its network and each one
 * egresses from wherever it landed, so on 26 Aug 2026 one instance answered from
 * ATL and worked perfectly while another, same image, same key, same minute, was
 * refused outright — which killed a staging job five seconds in. Pinning the
 * containers to North America does not help; placement is not egress.
 *
 * So the container works it out for itself, per instance, the first time it is
 * told no: switch to the Worker proxy — which egresses from an address Google
 * accepts — and carry on. One failed request, once, and then it is right for the
 * life of that instance.
 *
 * The proxy carries a 125-second ceiling (Cloudflare cuts a Worker's outbound
 * fetch), which is why image GENERATION should be on Vertex rather than here.
 * What comes through this path is judges and vision checks, and those answer in
 * seconds.
 */
// Read at call time, not at import. The container is handed its configuration by
// the platform, and a value frozen when the module loaded is a value that ignores
// whatever was set afterwards.
const proxyUrl = () => process.env.GEMINI_PROXY_URL || null;
const proxyKey = () => process.env.GEMINI_PROXY_KEY || null;
const vertexKey = () => process.env.VERTEX_API_KEY || null;
const VERTEX_BASE = 'https://aiplatform.googleapis.com/v1/publishers/google';
const GEO_BLOCKED = /User location is not supported|FAILED_PRECONDITION/i;

/**
 * THREE WAYS OUT, TRIED IN ORDER, AND THE CHOICE STICKS.
 *
 *   direct  Google's developer API from the container. Fastest, no middleman,
 *           no ceiling. Right whenever it works.
 *   vertex  The same models behind Google Cloud's front door. Different host,
 *           different capacity pool, and — measured on 26 Aug 2026 — reachable
 *           from container instances the developer API refuses outright. Also
 *           direct, so no ceiling either.
 *   proxy   Out through our own Worker, which egresses from an address Google
 *           has always accepted. Last, because Cloudflare cuts a Worker's
 *           outbound fetch at 125 seconds. Harmless for judges, which answer in
 *           seconds; fatal for image generation, which is why generation never
 *           takes this rung (transform.js sends it to Vertex instead).
 *
 * WHY A LADDER AND NOT A SETTING
 * The geo-block has now been diagnosed wrongly twice, both times by measuring one
 * container and concluding something about the deployment. It is neither on nor
 * off: Cloudflare places instances across its network, each egresses from
 * wherever it landed, and on 26 Aug one instance answered happily from ATL while
 * another — same image, same key, same minute — was refused and killed a job five
 * seconds in. Worse, the Worker proxy that fixed it in Round 27 was ALSO refused
 * from one of those instances, so even the fallback was not a fallback.
 *
 * A thing that varies per instance has to be decided per instance. One refused
 * request, once, and that container knows its way out for the rest of its life.
 */
const DOORS = ['direct', 'vertex', 'proxy'];

/**
 * Which rung to start on. Normally the top — try the fast direct path and let a
 * refusal teach us otherwise. `GEMINI_DOOR` starts lower, which is worth having
 * for two reasons: it makes the lower rungs testable against the real services
 * rather than only against a fake fetch, and if the developer API is ever known
 * to be bad it saves one refused request per container instance.
 */
function startingDoor() {
  const chosen = (process.env.GEMINI_DOOR || '').toLowerCase();
  if (DOORS.includes(chosen)) return chosen;
  return process.env.GEMINI_BASE_URL ? 'proxy' : 'direct'; // already pointed somewhere on purpose
}
let door = startingDoor();

/** Where a generateContent call goes right now, and with which credential. */
const meter = require('./meter.js');

function route(url, apiKey, at = door) {
  if (at === 'vertex' && vertexKey()) {
    return { url: url.replace(`${DIRECT}/models`, `${VERTEX_BASE}/models`), key: vertexKey(), door: at };
  }
  const proxy = proxyUrl();
  if (at === 'proxy' && proxy) return { url: url.replace(DIRECT, proxy), key: proxyKey() || apiKey, door: at };
  return { url, key: apiKey, door: 'direct' };
}

/** The next door worth trying, or null when there are none left. */
function nextDoor(from = door) {
  const rest = DOORS.slice(DOORS.indexOf(from) + 1);
  for (const d of rest) {
    if (d === 'vertex' && vertexKey()) return d;
    if (d === 'proxy' && proxyUrl()) return d;
  }
  return null;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_HTTP_RETRIES = 4;
/* A hung request is worse than a failed one: without this, a single socket that
   never answers stalls the whole job forever (seen 2026-08-23 — a verification
   run sat on one request for 15 minutes with no retry, because fetch has no
   default timeout). Generation legitimately takes ~35s; judge calls are seconds. */
/**
 * Three minutes was set when nobody had measured what a generation takes. Now we
 * have: at 2K, a healthy image comes back in 27–37 seconds, and every render is
 * 2K. Three minutes is not headroom, it is five times the real number, and the
 * only thing it buys is the right to sit on a socket that has already died.
 *
 * Measured on a live batch, 27 Aug 2026: one `empty` job spent 412 seconds — a
 * "Vertex request timed out after 77s", then the other door, then patient
 * retries, all inside a single attempt. The job budget could not stop it,
 * because it only decides whether to START an attempt; an attempt already
 * running is deliberately left alone so a paid generation is never thrown away.
 * The lever that actually bounds this is the one below.
 *
 * Two minutes: double the worst generation ever observed, and half of what a
 * hung request used to cost.
 */
const TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '120000', 10);

/**
 * THE JOB'S DEADLINE, not this request's.
 *
 * Retrying is right — Google returns 503 often enough that giving up on the
 * first one would fail jobs that were about to work. But the retry budget here
 * had no idea a customer was waiting at the other end of it. Four retries, each
 * allowed 180 seconds, with backoff between them, is over twelve minutes of
 * waiting available to a SINGLE call — and a job makes several. That is how a
 * job that should take two minutes became the ten-minute wait Kyle watched on
 * 26 Aug: not one slow thing, a patient thing.
 *
 * So transform.js sets the moment the whole job must be finished by, and every
 * request measures itself against it: no attempt is given more time than the job
 * has left, and no backoff is slept through if there is no time to use what it
 * is waiting for. Unset (CLI runs, tests), behaviour is exactly as before.
 */
let DEADLINE = null;
const setDeadline = (ts) => { DEADLINE = ts || null; };
const msLeft = (now = Date.now()) => (DEADLINE === null ? Infinity : DEADLINE - now);

/**
 * The outage circuit breaker (31 Aug 2026).
 *
 * During a broad "high demand" incident, EVERY stage of an attempt — the room
 * catalogue, the generations, the judges — fails with transient 500/503s. Each
 * call retries politely through its own backoff, so no single stage ever
 * concludes anything; the attempt crawls until the container's hard kill at ten
 * minutes, the kill carries no verdict, and the job re-runs the identical crawl.
 * Seen live: seven consecutive ten-minute runs, 77 minutes of "working".
 *
 * The breaker gives the process one shared memory across all of that:
 * consecutive transient failures, on any call, at any stage. Any successful
 * response resets it — proof Google is answering. Once it trips, every further
 * call in this process fails INSTANTLY with an error the whole reporting chain
 * already understands as "the image service is busy" (it carries '503' and
 * 'high demand'), so the attempt collapses in seconds, the container reports an
 * honest outage, and the Worker parks the job for the retry queue instead of
 * burning ten minutes learning nothing. Each pipeline run is its own process,
 * so a fresh attempt always starts with a closed breaker.
 */
const OUTAGE_BREAKER_TRIPS = parseInt(process.env.OUTAGE_BREAKER_TRIPS || '8', 10);
/**
 * PER MODEL, not process-wide — the evening's lesson (31 Aug 2026).
 *
 * The first version kept ONE count across every model, and it strangled the
 * exact failover it was meant to protect: during a pro-image outage the pro
 * attempts racked up the 8 strikes first, so when generateImage said "pro is
 * down at every door — falling back to flash" the already-open breaker failed
 * the flash call BEFORE A SINGLE REQUEST WAS SENT. Two beta stagings died at
 * the cutoff that evening with flash possibly healthy the whole time — nobody
 * ever asked it. Each model now carries its own count: a dead model still
 * fails fast, and the models that might be alive still get their chance.
 */
const transientsByModel = Object.create(null);
const keyFor = m => m || 'unknown';
const outageBreakerOpen = (model) => (transientsByModel[keyFor(model)] || 0) >= OUTAGE_BREAKER_TRIPS;
const outageBreakerError = (model) => {
  const e = new Error(`Gemini 503: upstream outage — ${transientsByModel[keyFor(model)] || 0} consecutive transient failures ` +
    `on ${keyFor(model)}, model currently experiencing high demand; stopping this attempt early (circuit breaker)`);
  e.upstreamOutage = true;
  return e;
};
// Test hooks only.
const _outageBreaker = {
  count: (model) => model === undefined
    ? Object.values(transientsByModel).reduce((a, b) => Math.max(a, b), 0)
    : (transientsByModel[keyFor(model)] || 0),
  reset: () => { for (const k of Object.keys(transientsByModel)) delete transientsByModel[k]; },
  trip: (model) => { transientsByModel[keyFor(model)] = OUTAGE_BREAKER_TRIPS; },
};


/**
 * `{"__proxy":{"status":n},"body":"<google's raw reply>"}`, possibly preceded by
 * the keepalive spaces the proxy sent while waiting. Anything else is passed
 * through untouched, so talking to Google directly is unchanged.
 */
function unwrapProxy(httpStatus, raw) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{') || !trimmed.includes('"__proxy"')) return { status: httpStatus, text: raw };
  try {
    const env = JSON.parse(trimmed);
    if (!env || !env.__proxy) return { status: httpStatus, text: raw };
    return { status: env.__proxy.status ?? httpStatus, text: typeof env.body === 'string' ? env.body : JSON.stringify(env.body) };
  } catch {
    // A truncated envelope means the connection died mid-answer. Treat it as a
    // transient upstream failure rather than parsing garbage as a result.
    return { status: 502, text: 'proxy response was incomplete' };
  }
}

/**
 * POST with a hard timeout, retry, and exponential backoff on transient failures.
 *
 * `retries` is overridable because how patient to be depends on whether there is
 * anywhere else to go. Five tries over twenty-five seconds is right when this is
 * the only door; it is twenty-five seconds thrown away when the caller has a
 * second provider standing by that is very likely up — see generateImage in
 * transform.js.
 */
async function post(url, apiKey, body, retries = MAX_HTTP_RETRIES, modelName = null, timeoutMs = null) {
  let lastErr;
  // How many times this call has stepped down the ladder. Bounded, because a
  // rung that cannot serve THIS endpoint routes straight back to direct — the
  // image `interactions` endpoint has no Vertex equivalent at this URL — and
  // "give the attempt back and try again" would then loop forever.
  let reroutes = 0;
  for (let i = 0; i <= retries; i++) {
    // A tripped outage breaker fails every call TO THIS MODEL instantly — see
    // its comment above. Checked inside the loop as well as gating new calls,
    // so a call already mid-backoff also stops rather than finishing its ladder.
    if (outageBreakerOpen(modelName)) throw outageBreakerError(modelName);
    // Never start a call the job has no time to receive the answer to.
    const budget = Math.min(timeoutMs || TIMEOUT_MS, msLeft());
    if (budget <= 0) throw lastErr || new Error('Gemini call abandoned: the job ran out of time');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budget);
    const hop = route(url, apiKey);
    const callT0 = Date.now();
    try {
      const res = await fetch(hop.url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': hop.key,
          'Content-Type': 'application/json',
          // Left over from the Worker-proxy era: it told the proxy this client
          // could read a keepalive envelope. The proxy is a plain passthrough
          // again and Google ignores unknown headers, so this is inert — kept
          // only so that flipping GEMINI_VIA_WORKER back on still works against
          // any older Worker still in the field.
          'x-ll-envelope': '1',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const raw = await res.text();
      // Through our own proxy the reply arrives in an envelope, because the HTTP
      // status has to be sent before Google has answered — see proxyToGoogle in
      // worker.js. Unwrap it so everything below still reasons about Google's
      // real status, including the retry decision.
      const { status, text } = unwrapProxy(res.status, raw);
      let usage = null;
      try { usage = JSON.parse(text).usageMetadata || null; } catch {}
      // The model name comes from the caller when it knows it. Parsing it out of
      // the URL worked for /models/<name>:generateContent and returned null for
      // every image call, because nanoBananaEdit posts to /interactions with the
      // model in the BODY. The meter then priced every image at the default —
      // gemini-3-pro-image — so a run on a cheaper model was billed at the dear
      // one's rate. Found by the fallback evaluation, 27 Aug 2026.
      meter.note({ kind: /image|interactions/i.test(url) ? 'image' : 'flash',
                   model: modelName || url.split('/models/')[1]?.split(':')[0] || null,
                   door: hop.door, ms: Date.now() - callT0, ok: status >= 200 && status < 300, status, attempt: i + 1,
                   promptTokens: usage?.promptTokenCount ?? null, outputTokens: usage?.candidatesTokenCount ?? null });
      if (status >= 200 && status < 300) { transientsByModel[keyFor(modelName)] = 0; return JSON.parse(text); }
      // Refused by location. Not a retry — the identical request from the
      // identical place will be refused again. Step down the ladder instead, and
      // try this call again immediately. The attempt is given back, because as
      // far as Google is concerned it never happened, and spending a retry on it
      // would leave a genuinely flaky call one short later in the same job.
      if (status === 400 && GEO_BLOCKED.test(text) && reroutes < DOORS.length) {
        const next = nextDoor(hop.door);
        if (next) {
          door = next;
          reroutes++;
          console.error(`  Google refused this container by location — switching to ${next} for the rest of this instance`);
          i--;
          continue;
        }
      }
      lastErr = new Error(`Gemini ${status}: ${text.slice(0, 300)}`);
      if (!RETRY_STATUS.has(status)) throw lastErr;
    } catch (e) {
      lastErr = e.name === 'AbortError'
        ? new Error(`Gemini request timed out after ${(budget / 1000).toFixed(0)}s`)
        : e;
      if (/^Gemini \d{3}/.test(lastErr.message) && !RETRY_STATUS.has(+lastErr.message.slice(7, 10))) throw lastErr;
    } finally {
      clearTimeout(timer);
    }
    // Reaching here means this try failed transiently (hard failures threw
    // above). One count per model, shared across every stage of the process —
    // see the breaker's comment.
    transientsByModel[keyFor(modelName)] = (transientsByModel[keyFor(modelName)] || 0) + 1;
    if (i < retries) {
      const wait = Math.min(30000, 1500 * 2 ** i) + Math.floor(Math.random() * 500);
      // Sleeping past the deadline helps nobody: the retry it is waiting for
      // would be refused on arrival. Stop now and let the caller report it.
      if (wait + 5000 > msLeft()) {
        console.error(`  transient API error (${lastErr.message.slice(0, 60)}…) — no time left to retry`);
        break;
      }
      console.error(`  transient API error (${lastErr.message.slice(0, 60)}…) — retrying in ${(wait / 1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Edit an image with Nano Banana Pro. Returns {data, mime_type} (base64).
 */
async function nanoBananaEdit(apiKey, prompt, imageB64, imageMime, opts = {}) {
  const model = opts.model || 'gemini-3-pro-image';
  // opts.references: [{label, data, mime_type}] — shown BEFORE the working image as worked examples.
  const refParts = (opts.references || []).flatMap(r => [
    { type: 'text', text: r.label },
    { type: 'image', mime_type: r.mime_type || 'image/jpeg', data: r.data },
  ]);
  const body = {
    model,
    input: [
      { type: 'text', text: prompt },
      ...refParts,
      ...(refParts.length ? [{ type: 'text', text: 'NOW THE PHOTO TO EDIT (output this one, transformed):' }] : []),
      { type: 'image', mime_type: imageMime, data: imageB64 },
    ],
    response_format: {
      type: 'image',
      mime_type: 'image/jpeg',
      image_size: opts.imageSize || '2K',
      ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
    },
  };
  const json = await post(`${BASE}/interactions`, apiKey, body, opts.retries, model);
  // Interactions API shape (verified 2026-08): the image is in
  // steps[].content[] on the step whose type is 'model_output'.
  // Older/alternate shapes are kept as fallbacks.
  const stepImage = (json.steps || [])
    .filter(s => s.type === 'model_output')
    .flatMap(s => s.content || [])
    .find(p => p.type === 'image' && p.data);
  const out = stepImage
    || json.output_image
    || json.output?.find?.(p => p.type === 'image')
    || json.outputs?.find?.(p => p.type === 'image');
  if (!out || !out.data) throw new Error('No image in response: ' + JSON.stringify(json).slice(0, 400));
  return { data: out.data, mime_type: out.mime_type || 'image/jpeg' };
}

async function geminiGenerateContent(apiKey, model, body) {
  /**
   * FAIL FAST WHEN A BACKUP JUDGE EXISTS (1 Sep 2026). The morning validation
   * batch lost a bedroom staging to the give-up ceiling because judge calls
   * gave a jammed Google FIVE chances at up to 120s each — the job's whole
   * clock died inside Google's retry ladder and the fal door never got asked
   * ("no time left" guards refused it at the end). With a backup available,
   * Google gets two brisk tries at 45s, then the backup takes the call with
   * most of the budget still in hand. Without a backup, nothing changes.
   */
  const hasBackup = !!(process.env.ANTHROPIC_API_KEY || process.env.FAL_KEY);
  try {
    return await post(`${BASE}/models/${model || 'gemini-3.6-flash'}:generateContent`, apiKey, body,
      hasBackup ? 1 : undefined, model, hasBackup ? 45_000 : null);
  } catch (err) {
    /**
     * THE BACKUP JUDGE (31 Aug 2026). Every text/vision call in the pipeline —
     * judges, classifiers, room plans, scope checks — comes through here, and
     * on 31 Aug one Google outage took the judge models down WITH the image
     * model, stranding a paid, finished generation that nothing could approve.
     * When Google's answer is an outage (or the circuit breaker is already
     * open), the identical request goes to Anthropic instead, wearing Gemini's
     * request and response shapes so no caller knows the difference — see
     * anthropic.js. Image GENERATION never routes here (nanoBananaEdit does
     * not call this function); a backup judge cannot draw, only judge.
     * Dormant unless ANTHROPIC_API_KEY is set.
     */
    const backupKey = process.env.ANTHROPIC_API_KEY;
    const falKey = process.env.FAL_KEY;
    const OUTAGE_LIKE = /\b(429|500|502|503|504|529)\b|UNAVAILABLE|high demand|overloaded|timed out/i;
    const outage = err.upstreamOutage || OUTAGE_LIKE.test(String(err && err.message));
    if ((!backupKey && !falKey) || !outage || msLeft() < 20_000) throw err;
    // A direct Anthropic key wins (no middleman); the fal door is the one that
    // exists in production TODAY, riding the FAL_KEY the third generation door
    // already uses (1 Sep 2026, Kyle: "Can't we do it through fal?").
    if (backupKey) {
      console.error(`  Google's judge refused (${String(err && err.message).slice(0, 60)}…) — asking the backup judge`);
      const { anthropicGenerateContent } = require('./anthropic.js');
      return anthropicGenerateContent(backupKey, body, { timeoutMs: Math.min(60_000, msLeft()) });
    }
    console.error(`  Google's judge refused (${String(err && err.message).slice(0, 60)}…) — asking the backup judge through fal`);
    const { falVisionJudge } = require('./fal.js');
    return falVisionJudge(falKey, body, { timeoutMs: Math.min(60_000, msLeft()) });
  }
}

module.exports = { nanoBananaEdit, geminiGenerateContent, unwrapProxy, setDeadline, msLeft,
  _outageBreaker,
  _routing: () => ({ door, proxyUrl: proxyUrl(), vertex: !!vertexKey() }),
  _resetRouting: () => { door = startingDoor(); } };
