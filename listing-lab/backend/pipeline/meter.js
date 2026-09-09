/**
 * Listing Lab — the meter. What did this job spend, and where did the time go?
 *
 * WHY THIS EXISTS
 * Before the 88-frame golden run, Kyle asked for analytics on all of it: "I
 * don't wanna see time, meanwhile is what we're getting to." Fair. The audit
 * already recorded timing, but as CUMULATIVE MARKS — "judge: 34.2s" meaning the
 * judge finished 34.2 seconds after the job started. That answers "when", never
 * "how long", and across 88 jobs nobody is subtracting those by hand.
 *
 * So this records DURATIONS, and it counts what each call actually cost.
 *
 * COST MODEL — measured, not guessed. From REVIEW.md round notes:
 *   image at 2K  $0.134     image at 4K  $0.240
 *   flash call   ~$0.032 (a vision call carrying an image; text-only is far less
 *                but we do not make many of those, so one rate keeps it honest
 *                and slightly pessimistic, which is the right way to be wrong
 *                about money).
 */

/**
 * PRICES — from Google's published table, Aug 2026, not from anybody's memory.
 * https://ai.google.dev/gemini-api/docs/pricing
 *
 * Per million tokens. Image models bill a generated image as OUTPUT tokens:
 * gemini-3-pro-image is 1,120 tokens at 1K/2K and 2,000 at 4K, which is where
 * the familiar $0.134 and $0.24 per image come from.
 *
 * A NOTE ON GETTING THIS WRONG. The first version of this file priced every
 * vision call at a flat $0.032, inferred from a round note that said "3
 * generations plus ~10 flash calls ≈ $0.72". That made the first real declutter
 * job report $0.58 when it actually cost about $0.17 — roughly 12x over on the
 * flash calls, because those ten calls in the round note were staging critic
 * calls carrying full-resolution crops, not the small checks a declutter runs.
 * Kyle was about to fund an 88-job account off that number. Hence: real rates,
 * real token counts off usageMetadata, and a flat rate only as a last resort.
 */
const RATES = {
  'gemini-3-pro-image':  { in: 2.00, out: 120.00 },
  'gemini-3.1-flash-image': { in: 0.50, out: 60.00 },
  'gemini-2.5-flash-image': { in: 0.30, out: 30.00 },
  'gemini-3.6-flash':    { in: 0.75, out: 3.75 },
  'gemini-3.7-flash':    { in: 0.75, out: 3.75 },
  'gemini-3.5-flash':    { in: 1.50, out: 9.00 },
};
const DEFAULT_IMAGE_RATE = RATES['gemini-3-pro-image'];
const DEFAULT_FLASH_RATE = RATES['gemini-3.6-flash'];

/**
 * Output tokens one generated image bills as, by model and requested size.
 * Per MODEL, because they differ: gemini-3-pro-image bills 1,120 at 1K/2K and
 * 2,000 at 4K; gemini-3.1-flash-image bills 1,120 / 1,680 / 2,520. Using pro's
 * table for every model is what made a flash run report pro prices.
 */
const IMAGE_OUTPUT_TOKENS = {
  'gemini-3-pro-image':     { '1K': 1120, '2K': 1120, '4K': 2000 },
  'gemini-3.1-flash-image': { '1K': 1120, '2K': 1680, '4K': 2520 },
  'gemini-2.5-flash-image': { '1K': 1290, '2K': 1290, '4K': 1290 },
};
const DEFAULT_IMAGE_TOKENS = IMAGE_OUTPUT_TOKENS['gemini-3-pro-image'];

/** Kept for callers that just want "what does an image cost". */
const IMAGE_COST = { '1K': 0.134, '2K': 0.134, '4K': 0.240 };

function rateFor(model, kind) {
  if (model && RATES[model]) return RATES[model];
  // Unknown model: guess by kind rather than silently bill at zero.
  return kind === 'image' ? DEFAULT_IMAGE_RATE : DEFAULT_FLASH_RATE;
}

/** What one call cost. Measured from tokens when the API reported them. */
/**
 * FAL PRICES ARE FAL'S, NOT GOOGLE'S (2 Sep 2026, Kyle: "are you getting
 * accurate spend data from fal?"). fal's API reports no token usage, so
 * fal-door calls were falling to Google's flat $0.134/image — but fal bills
 * nano-banana-pro at $0.15 per image (their published price, verified when
 * the third door was built), which under-counted every fal generation ~12%.
 * fal's vision-judge calls (any-llm, haiku) are booked at a per-call estimate
 * sized to an image-bearing haiku request. These are still ESTIMATES — fal
 * returns no billing data per call; the authoritative number is the fal
 * dashboard, and these rates exist to track it closely, not to replace it.
 */
const FAL_IMAGE_COST = parseFloat(process.env.FAL_IMAGE_COST || '0.15');
const FAL_JUDGE_COST = parseFloat(process.env.FAL_JUDGE_COST || '0.008');

function costOf(call, imageSize = '2K') {
  if (!call.ok) return 0;                       // neither vendor bills a 4xx/5xx
  if (call.door === 'fal') {
    if (call.kind === 'image') return FAL_IMAGE_COST;
    return FAL_JUDGE_COST;
  }
  const rate = rateFor(call.model, call.kind);
  const inTok = call.promptTokens;
  let outTok = call.outputTokens;
  // Image responses do not always report the image in candidatesTokenCount.
  if (call.kind === 'image' && !outTok) {
    const table = IMAGE_OUTPUT_TOKENS[call.model] || DEFAULT_IMAGE_TOKENS;
    outTok = table[imageSize] ?? table['2K'];
  }
  if (inTok == null && outTok == null) {
    return call.kind === 'image' ? (IMAGE_COST[imageSize] ?? 0.134) : 0.003;
  }
  return ((inTok || 0) * rate.in + (outTok || 0) * rate.out) / 1e6;
}

function newMeter() {
  return {
    t0: Date.now(),
    phases: [],          // { name, ms, atMs }  — DURATION first, that is the point
    calls: [],           // { kind, model, door, ms, ok, status, attempt }
    _open: new Map(),
  };
}

/** Time one phase. start() returns the stop function — impossible to mismatch. */
function start(meter, name) {
  const t = Date.now();
  return (extra) => {
    const ms = Date.now() - t;
    meter.phases.push({ name, ms, atMs: t - meter.t0, ...(extra || {}) });
    return ms;
  };
}

/** Record one upstream call. `kind` is 'image' or 'flash'. */
function record(meter, { kind, model, door, ms, ok = true, status = null, attempt = null, imageSize = null,
                         promptTokens = null, outputTokens = null }) {
  if (!meter) return;
  meter.calls.push({ kind, model, door, ms, ok, status, attempt, imageSize, promptTokens, outputTokens });
}

/** What did it cost, and what did it spend the time on? */
function summarise(meter, { imageSize = '2K' } = {}) {
  const images = meter.calls.filter(c => c.kind === 'image');
  const flash = meter.calls.filter(c => c.kind === 'flash');
  const okImages = images.filter(c => c.ok).length;
  const cost = meter.calls.reduce((s, c) => s + costOf(c, imageSize), 0);
  const tokens = meter.calls.reduce((a, c) => {
    a.in += c.promptTokens || 0; a.out += c.outputTokens || 0; return a;
  }, { in: 0, out: 0 });

  // Where the wall clock actually went, biggest first. This is the answer to
  // "why did that take four minutes".
  const byPhase = {};
  for (const p of meter.phases) byPhase[p.name] = (byPhase[p.name] || 0) + p.ms;
  const timeSpent = Object.entries(byPhase)
    .sort((a, b) => b[1] - a[1])
    .map(([name, ms]) => ({ name, seconds: +(ms / 1000).toFixed(1) }));

  // Retries and reroutes are the hidden time. Surface them explicitly.
  const failedCalls = meter.calls.filter(c => !c.ok);
  const doors = {};
  for (const c of meter.calls) if (c.door) doors[c.door] = (doors[c.door] || 0) + 1;

  return {
    wallSeconds: +((Date.now() - meter.t0) / 1000).toFixed(1),
    cost: +cost.toFixed(4),
    tokens,
    images: okImages,
    flashCalls: flash.filter(c => c.ok).length,
    timeSpent,
    upstreamSeconds: +(meter.calls.reduce((s, c) => s + (c.ms || 0), 0) / 1000).toFixed(1),
    failedCalls: failedCalls.map(c => ({ kind: c.kind, door: c.door, status: c.status, ms: c.ms })),
    doors,
  };
}

/**
 * The current job's meter. One job = one spawned process (container/server.js
 * spawns `node` per job), so a module-level current is safe and saves threading
 * a meter through every call site in the pipeline.
 */
let current = null;
const setMeter = (m) => { current = m; return m; };
const getMeter = () => current;
/** Record against the current job's meter, if a job is running. */
const note = (call) => { if (current) record(current, call); };

module.exports = { newMeter, start, record, summarise, setMeter, getMeter, note, costOf, RATES, IMAGE_COST, IMAGE_OUTPUT_TOKENS };
