/**
 * The backup judge (31 Aug 2026).
 *
 * Six Google "high demand" windows in six days of building, and one of them
 * stranded a PAID, finished generation because the flash-family JUDGE models
 * went down with everything else — the photograph existed and nothing could
 * approve it. Kyle's call: keep Google for generation (flash fallback covers
 * the common case there), but the CHECKS get a second vendor, so the only
 * thing a full Google outage can stall is generation itself.
 *
 * This module speaks Anthropic's Messages API but wears Gemini's shapes on
 * both sides: it takes the exact request body the pipeline builds for
 * geminiGenerateContent and returns a response in Gemini's envelope
 * (candidates[0].content.parts[0].text), so not one judge, classifier, or
 * room-plan call needed changing — the fallback happens entirely inside
 * gemini.js. Image GENERATION never routes here; Claude does not draw.
 *
 * Dormant unless ANTHROPIC_API_KEY is set in the environment.
 */

const meter = require('./meter.js');

const API_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
// Haiku: vision-capable, priced for exactly this kind of per-image judging.
const JUDGE_MODEL = process.env.ANTHROPIC_JUDGE_MODEL || 'claude-haiku-4-5';

/** Gemini request body → Anthropic Messages request. */
function toAnthropic(body) {
  const parts = (body.contents?.[0]?.parts) || [];
  const content = parts.map(p =>
    p.text !== undefined
      ? { type: 'text', text: p.text }
      : p.inline_data
        ? { type: 'image', source: { type: 'base64', media_type: p.inline_data.mime_type || 'image/jpeg', data: p.inline_data.data } }
        : null
  ).filter(Boolean);
  return {
    model: JUDGE_MODEL,
    max_tokens: 8000,
    temperature: body.generationConfig?.temperature ?? 0,
    // Every caller's prompt already demands bare JSON; this holds the line the
    // way Gemini's response_mime_type does.
    system: 'You are a precise vision inspector for a real-estate photo system. Respond with ONLY the JSON the user requests — no markdown fences, no commentary, no preamble.',
    messages: [{ role: 'user', content }],
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Call Anthropic with a Gemini-shaped body, answer in a Gemini-shaped envelope.
 * Two tries; a second vendor that is ALSO down is simply down — the error
 * propagates and the job parks exactly as it would have without a backup.
 */
async function anthropicGenerateContent(apiKey, geminiBody, opts = {}) {
  const req = toAnthropic(geminiBody);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 60_000);
    const t0 = Date.now();
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: ac.signal,
      });
      const text = await res.text();
      meter.note({ kind: 'anthropic-judge', model: req.model, ms: Date.now() - t0,
                   ok: res.ok, status: res.status, attempt: i + 1 });
      if (!res.ok) {
        lastErr = new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
        if (res.status === 429 || res.status >= 500) { await sleep(1500 * (i + 1)); continue; }
        throw lastErr;
      }
      const out = JSON.parse(text);
      let reply = (out.content || []).map(c => c.text || '').join('');
      // Belt and suspenders against fenced JSON — Gemini's json mode never
      // fences, and the parsers upstream expect that.
      reply = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      return { candidates: [{ content: { parts: [{ text: reply }] } }], __judgedBy: 'anthropic' };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('Anthropic request timed out') : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

module.exports = { anthropicGenerateContent, toAnthropic, JUDGE_MODEL };
