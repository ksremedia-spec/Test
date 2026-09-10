/**
 * Listing Lab — the Cloudflare Worker.
 *
 * This is everything the browser talks to. It never returns an API key, never
 * calls Google, and never lets the browser name its own price.
 *
 * Bindings expected in wrangler.toml:
 *   DB          D1 database (schema.sql)
 *   PHOTOS      R2 bucket — originals and results
 *   PIPELINE    the Container running the Node pipeline (sharp lives there)
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   (secrets)
 *   SITE_URL    e.g. https://listinglab.com
 */

import {
  Ledger, LedgerError, TRANSFORMATION_COST, ATTEMPTS_PER_CREDIT,
  CREDIT_PACKS, creditKeyFor, CREDIT_GRANTING_EVENT,
} from './ledger.js';
import { verifyStripeWebhook, creditGrantFromEvent, StripeVerificationError } from './stripe.js';
import {
  hashPassword, verifyPassword, newSession, hashToken, normaliseEmail, randomId,
  sessionCookie, clearedSessionCookie, readSessionCookie, isExpired, AuthError,
} from './auth.js';
import { Store } from './store.js';
import { verifyAppleIdentityToken, AppleVerificationError, APP_BUNDLE_ID } from './apple.js';
import { pushConfigured, sendPush, jobFinishedMessage } from './apns.js';
import { zipStream } from './zip.js';
import { GRADER_HTML } from './grader.js';
import { livePage, liveJobsJson, liveJobJson } from './live-page.js';
import { PROMOS_HTML } from './promos-page.js';
import { REPORTS_HTML } from './reports-page.js';
import { BOARD_PAGE } from './board-page.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { ...JSON_HEADERS, ...(init.headers || {}) } });

const fail = (status, code, message) => json({ error: { code, message } }, { status });

/** Errors we raise deliberately are safe to show. Anything else is not. */
function errorResponse(err) {
  if (err instanceof LedgerError || err instanceof AuthError) {
    const status = {
      INSUFFICIENT_CREDITS: 402,
      ATTEMPTS_EXHAUSTED: 409,
      JOB_ALREADY_CHARGED: 409,
      CREDITS_ALREADY_RETURNED: 409,
      EMAIL_TAKEN: 409,
      UNKNOWN_TRANSFORMATION: 400,
      UNKNOWN_STYLE: 400,
      UNKNOWN_ROOM: 400,
      WEAK_PASSWORD: 400,
      INVALID_EMAIL: 400,
    }[err.code] || 400;
    return fail(status, err.code, err.message);
  }
  // Never leak a stack trace or a database message to the browser.
  console.error('unhandled', err?.stack || err);
  return fail(500, 'INTERNAL', 'Something went wrong on our end.');
}

const nowISO = () => new Date().toISOString();

/**
 * WAITING OUT SOMEONE ELSE'S OUTAGE
 *
 * Google's image model serves from a shared pool and answers 500 —
 * "gemini-3-pro-image is currently experiencing high demand" — when that pool is
 * saturated. Three things are true about it and all three matter here:
 *
 *   · It is not our quota. A paid tier raises rate limits; it buys no capacity.
 *   · It is not our key, our region or the customer's photograph.
 *   · It hits everyone at once, and on 26 Aug 2026 it lasted over an hour.
 *
 * The old behaviour was to fail the job, refund the credit, and show the agent
 * "That one did not finish". That is the product failing at the only thing it
 * promises, over a condition that resolves itself.
 *
 * So an outage no longer finishes a job. The job is parked with a time to try
 * again, a scheduled sweep re-dispatches it, and the agent sees that their photo
 * is still queued. Nothing is charged in the meantime — the credit is held, not
 * spent, and if the window finally runs out it comes back exactly as before.
 *
 * Thirty minutes of window, in ninety-second steps. Long enough to cover the
 * outages actually observed; short enough that nobody waits on a dead model all
 * afternoon.
 */
const OUTAGE_RETRY_LIMIT = 20;
const OUTAGE_RETRY_SPACING_MS = 90 * 1000;

/**
 * A JOB THAT SAYS NOTHING AT ALL
 *
 * Every path through the pipeline reports back — delivered, rejected, outage,
 * even its own hard kill at ten minutes. Silence is not a result; it means the
 * container instance went away mid-render, which is exactly what a deploy does.
 *
 * Seen on 26 Aug 2026: a declutter sat at 'queued' for twenty minutes, credit
 * spent, nothing to show. That is worse than a failure, because a failure ends.
 *
 * So the same sweep that drains the outage queue also picks up anything that has
 * gone quiet: STALE_AFTER_MS to be re-dispatched, GIVE_UP_AFTER_MS to be failed
 * and refunded. Twelve minutes is comfortably past anything legitimate — the
 * pipeline's own budget stops a job at four minutes and the container kills a
 * wedged one at ten.
 *
 * GIVE_UP: fifteen minutes, down from forty (Kyle, 31 Aug 2026, after a beta
 * client watched "working" for over an hour): "Agents don't wanna wait forty
 * minutes. If they wanted forty minutes, they would've went with someone who
 * did this by hand." Normal delivery is 2–7 minutes; fifteen still allows two
 * full attempts around one outage park, and past that the honest answer is a
 * refund, not more waiting. This cutoff now binds EVERY path — silent jobs and
 * the outage retry queue alike — so no job can ever show "working" beyond it.
 */
const STALE_AFTER_MS = 12 * 60 * 1000;
/**
 * How long a HEARTBEATING container may go quiet before its job is provably
 * lost (1 Sep 2026). Containers pulse every 45s while a run is in flight, so
 * three minutes of silence is four missed beats — not a slow job, a dead one.
 * Kyle's 17-minute staging was a 4-minute run behind a lost dispatch that the
 * old silence rule took 12 minutes to notice. Jobs with no pulse at all (an
 * older container image) keep the patient 12-minute rule above.
 */
const HB_STALE_MS = 3 * 60 * 1000;
/**
 * A job that was HANDED to a container but never pulsed at all (9 Sep 2026).
 * Every container image in service beats the moment a run starts, before it
 * even fetches the original — so "dispatched, no first beat" is not a slow
 * job, it is a hand-off that died: the instance accepted /run and was gone
 * before the work began. Kyle's twilight tonight sat in "waiting to start"
 * for 12 minutes because that case fell under the patient rule above (written
 * for pre-heartbeat images that no longer exist). Two minutes is nearly three
 * missed first beats; past that the job is re-dispatched to another slot.
 */
const NO_FIRST_BEAT_MS = 2 * 60 * 1000;   // also covers "created, never handed off" (see store.claimStalledJobs)
const GIVE_UP_AFTER_MS = 15 * 60 * 1000;

/**
 * The closed option sets, checked HERE and not only in the browser.
 *
 * The pipeline validates these too and exits if they are wrong — which is
 * correct, but by then the credit has been taken and the customer has waited for
 * a container to start, only to be told "something went wrong while producing
 * this photo". Seen live on 26 Aug 2026: a staging job with style "Transitional"
 * charged two credits and died five seconds later with a message that explained
 * nothing.
 *
 * A closed set the API does not enforce is a closed set in name only. The browser
 * is not a security boundary and it is not an input validator either.
 *
 * Kept in step with pipeline/prompts.js by a test, because two lists that drift
 * apart is how a legitimate style starts being refused.
 */
export const STAGING_STYLES = ['Standard', 'Modern', 'Contemporary', 'Coastal', 'Luxury'];
export const ROOM_TYPES = ['Living Room', 'Dining Room', 'Primary Bedroom', 'Guest Bedroom',
  'Nursery / Kids Room', 'Basement / Rec Room', 'Home Office', 'Other'];
export const TWILIGHT_MOODS = ['Dusk'];  // one look, decided 27 Aug 2026 (Kyle) — no Golden Hour / Blue Hour

/**
 * THE OWNER'S KEY, OUT OF THE ADDRESS BAR (hardening, 3 Sep 2026).
 *
 * The board and grader used to be reached only by `?s=<DIAG_SECRET>` — which
 * put the master key to every customer's photos into browser history, the
 * request logs, and every screenshot of the dashboard. Now a browser visit
 * with the secret is answered once: an HttpOnly cookie is set (a hash of the
 * secret, not the secret) and the browser is sent to the same page with the
 * secret stripped. Every later page, image and JSON call is authenticated by
 * the cookie. Old bookmarks keep working, `curl ...?s=` keeps working for the
 * runbook, and rotating DIAG_SECRET invalidates every cookie at once.
 */
const OWNER_COOKIE = 'll_owner';
const OWNER_COOKIE_DAYS = 30;

async function ownerCookieValue(secret) {
  const bytes = new TextEncoder().encode(`owner-cookie:${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * null when the caller is not the owner; otherwise `{ via }` — 'url' or
 * 'cookie' — plus `redirect` when a browser just arrived with the secret in
 * the URL and should be moved to the clean address.
 */
async function ownerAccess(request, url, env) {
  if (!env.DIAG_SECRET) return null;
  const expected = await ownerCookieValue(env.DIAG_SECRET);
  const cookie = (request.headers.get('cookie') || '')
    .split(/;\s*/).find(c => c.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
  if (cookie && cookie === expected) return { via: 'cookie' };
  if (url.searchParams.get('s') !== env.DIAG_SECRET) return null;
  const browser = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
  if (!browser) return { via: 'url' };
  const clean = new URL(url);
  clean.searchParams.delete('s');
  return {
    via: 'url',
    redirect: new Response(null, {
      status: 302,
      headers: {
        location: clean.pathname + clean.search,
        'set-cookie': `${OWNER_COOKIE}=${expected}; Max-Age=${OWNER_COOKIE_DAYS * 86400}; Path=/internal; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
      },
    }),
  };
}

/**
 * ONE ADDRESS, ALWAYS ENCRYPTED (hardening, 3 Sep 2026).
 *
 * Before this, http://thelistinglab.app served the site in the clear — a
 * sign-in typed on that page crossed the wire unencrypted — and www answered
 * as a second copy of the site. Now anything that is not https on the bare
 * domain is sent there with a permanent redirect, and HSTS tells browsers to
 * never try plain http again. Only applies when SITE_URL is https, so local
 * development (http://localhost) is untouched.
 */
function canonicalRedirect(url, env) {
  const site = env.SITE_URL || '';
  if (!site.startsWith('https://')) return null;
  const host = new URL(site).host;
  const wrongScheme = url.protocol !== 'https:';
  const wrongHost = url.host !== host && url.host === `www.${host}`;
  if (!wrongScheme && !wrongHost) return null;
  return Response.redirect(`https://${host}${url.pathname}${url.search}`, 301);
}

/**
 * The browser-side locks every response carries (hardening, 3 Sep 2026):
 * never load over http again (HSTS), never guess a content type, never let
 * another site frame us, never leak our URLs to third parties, and no page
 * may use camera/mic/location. HTML pages also get a Content Security
 * Policy — scripts and connections only from this origin, styles and fonts
 * additionally from Google Fonts, images from here plus the inline data:
 * illustrations and blob: previews the app makes. Pages that set their own
 * CSP (the owner board) keep theirs.
 */
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

function withSecurityHeaders(res) {
  // Redirects and streams from the asset binding come back immutable.
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  const type = out.headers.get('content-type') || '';
  if (type.startsWith('text/html') && !out.headers.has('content-security-policy')) {
    out.headers.set('content-security-policy', PAGE_CSP);
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const away = canonicalRedirect(url, env);
    if (away) return withSecurityHeaders(away);
    const store = new Store(env.DB);
    try {
      return withSecurityHeaders(await route(request, url, env, ctx, store));
    } catch (err) {
      return withSecurityHeaders(errorResponse(err));
    }
  },

  /**
   * The minute hand.
   *
   * Cloudflare calls this on the cron in wrangler.toml. It exists so a job
   * parked during an outage gets picked back up whether or not anyone still has
   * the tab open — an agent who uploads a photo and closes their laptop should
   * come back to a finished photograph, not to a job that stopped the moment
   * they stopped watching.
   *
   * Deliberately dumb: claim what is due, hand it to the pipeline, stop. All the
   * judgement about whether to retry at all was made when the job was parked.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepRetries(env, new Store(env.DB)));
    ctx.waitUntil(watchBudget(env, new Store(env.DB)));
    // Keep the classify container WARM (1 Sep 2026). Its idle timeout is three
    // minutes and this cron fires every one, so the first photo of a session
    // no longer pays a cold boot while the customer stares at 100%. Costs one
    // small always-on instance; the upload feel is worth it.
    ctx.waitUntil(env.PIPELINE.get(env.PIPELINE.idFromName('classify'))
      .fetch('https://pipeline.internal/health').catch(() => {}));
  },
};

/**
 * The owner's low-balance alarm (31 Aug 2026, asked for before production).
 *
 * Google will bill whatever the pipeline spends; nothing in their console
 * texts you before the tank runs dry. But every job writes its REAL metered
 * cost onto its row, so the truth is already in our own database — this
 * sweeps it once an hour, compares against the budget the owner set, and
 * emails at 75% and again at 90% through the same Email Routing binding the
 * support box uses. Each level fires ONCE per budget; topping up and raising
 * `budgetUsd` re-arms both.
 *
 * Founder jobs count here even though the dashboard excludes them — the
 * dashboard measures the business, this measures the Google bill, and Google
 * charges for founder tests too.
 */
export async function watchBudget(env, store) {
  const minute = new Date().getUTCMinutes();
  if (minute !== 7) return { skipped: true };   // hourly, off the :00 rush
  if (!env.SUPPORT_EMAIL) return { skipped: true };
  const budget = parseFloat(await store.getSetting('budgetUsd').catch(() => null));
  if (!budget || !(budget > 0)) return { skipped: true };
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS spent,
            COUNT(CASE WHEN cost_usd IS NULL AND status IN ('delivered','rejected','failed') THEN 1 END) AS unmetered
       FROM jobs WHERE created_at >= COALESCE((SELECT value FROM settings WHERE key = 'budgetSince'), '2026-08-30')`
  ).first();
  const spent = (row?.spent ?? 0) + (row?.unmetered ?? 0) * 0.45;
  const level = spent >= budget * 0.9 ? 90 : spent >= budget * 0.75 ? 75 : 0;
  if (!level) return { ok: true, spent };
  const already = parseInt(await store.getSetting('budgetAlerted').catch(() => '0'), 10) || 0;
  if (level <= already) return { ok: true, spent, alerted: already };
  const pct = Math.round(100 * spent / budget);
  const subject = `Listing Lab: Google spend at ${pct}% of your $${budget.toFixed(0)} budget`;
  const bodyText = [
    `Measured AI spend has reached $${spent.toFixed(2)} of the $${budget.toFixed(2)} you budgeted.`,
    '',
    level >= 90 ? 'This is the 90% alarm — top up the Google account now or pause generation from the dashboard.'
                : 'This is the 75% heads-up — worth topping up soon.',
    '',
    `Dashboard: ${env.SITE_URL}/owner`,
    'To re-arm after topping up, update the budget (ask Claude, or set budgetUsd in settings).',
  ].join('\r\n');
  const raw = [
    'From: Listing Lab <support@thelistinglab.app>',
    'To: ksremedia@gmail.com',
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <budget-${level}-${Date.now()}@thelistinglab.app>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText,
  ].join('\r\n');
  // Lazy import with a plain-object fallback so node tests can exercise the
  // send; the runtime always has the real module.
  let EmailMessage;
  try { ({ EmailMessage } = await import('cloudflare:email')); }
  catch { EmailMessage = function (from, to, msg) { return { from, to, raw: msg }; }; }
  try {
    await env.SUPPORT_EMAIL.send(new EmailMessage('support@thelistinglab.app', 'ksremedia@gmail.com', raw));
  } catch (e) {
    // A failed send must NOT mark the level as alerted — next hour tries again.
    console.error('budget alert email failed', e?.message || e);
    return { ok: false, spent };
  }
  await store.setSetting('budgetAlerted', String(level));
  return { ok: true, spent, alertSent: level };
}

export async function sweepRetries(env, store) {
  // The owner's brake covers the queue too: while generation is paused, parked
  // jobs stay parked and spend nothing. If the pause outlasts the reaper's
  // patience the usual promise applies — the credits go back.
  if (await store.getFlag('genPaused').catch(() => false)) return { paused: true };
  const now = Date.now();

  /**
   * THE WAIT CUTOFF, AGAINST THE CUSTOMER'S CLOCK (3 Sep 2026).
   *
   * Before anything else: any job that has been open longer than the give-up
   * age ends now, with a refund, whatever state it is in. The two checks
   * further down still exist (they catch the same thing a little earlier on
   * their own paths) but neither could see a job that was busy heartbeating —
   * the soak test's closet declutter showed "working" for 21 minutes. A result
   * that arrives after this has fired is dropped by the finish guard, which is
   * the trade the 15-minute promise makes on purpose.
   */
  let timedOut = 0;
  try {
    const overdue = await store.jobsPastGiveUp(new Date(now - GIVE_UP_AFTER_MS).toISOString());
    for (const job of overdue) {
      await failJobAndRefund(store, job,
        'This one took longer than we are willing to keep you waiting, so it was stopped. Your credits have been returned — please try again.', env);
      console.warn('wait cutoff: job stopped and refunded', job.id, job.status, job.transformation);
      timedOut++;
    }
  } catch (err) {
    console.error('retry sweep could not apply the wait cutoff', err?.message || err);
  }

  /**
   * Silent jobs FIRST, then the queue.
   *
   * The order is load-bearing. Draining the queue first clears `retry_after` on
   * everything it claims, and the staleness check — which looks for exactly
   * that, a job with no retry pending — would then pick the same jobs straight
   * back up and park them again. Two dispatches, two generations, two bills.
   *
   * Reviving first means a silent job is parked with a time already in the past,
   * and the drain below picks it up in this same sweep. One pass, one dispatch.
   */
  let stalled = [];
  try {
    stalled = await store.claimStalledJobs(new Date(now - STALE_AFTER_MS).toISOString(), new Date(now - HB_STALE_MS).toISOString(), 10, new Date(now - NO_FIRST_BEAT_MS).toISOString());
  } catch (err) {
    console.error('retry sweep could not look for silent jobs', err?.message || err);
  }

  let abandoned = 0;
  const revive = [];
  for (const job of stalled) {
    const age = now - Date.parse(job.created_at);
    if (age > GIVE_UP_AFTER_MS || (job.outage_retries || 0) >= OUTAGE_RETRY_LIMIT) {
      // Long past any honest hope. End it, and give the credit back.
      await failJobAndRefund(store, job,
        'That job stopped responding and we could not finish it. Your credits have been returned — please try again.', env);
      abandoned++;
      continue;
    }
    // Park it and let the next sweep dispatch it, so reviving a lost job goes
    // through exactly the same claim-once path as an outage retry rather than a
    // second route with its own bugs.
    const { parked } = await store.parkJobForRetry({ jobId: job.id, retryAfter: new Date(now - 1000).toISOString() });
    if (parked) { revive.push(job.id); }
  }
  if (revive.length) console.log(`retry sweep: ${revive.length} silent job(s) revived — ${revive.join(', ')}`);

  let due = [];
  try {
    due = await store.claimJobsDueForRetry(new Date(now).toISOString());
  } catch (err) {
    console.error('retry sweep could not read the queue', err?.message || err);
    return { claimed: 0, revived: revive.length, abandoned, timedOut };
  }
  if (!due.length) return { claimed: 0, revived: revive.length, abandoned, timedOut };
  console.log(`retry sweep: ${due.length} job(s) waiting on the image service`);
  for (const job of due) {
    // The wait cutoff, enforced HERE too. It used to live only on the silent-job
    // path, so a job actively cycling the outage queue could grind for 1.5–2
    // hours (20 parks × 90s wait × minutes-long attempts) while the customer
    // watched "working". Seen live 31 Aug 2026: a beta declutter at an hour and
    // counting. Past the give-up age nothing about the next attempt is more
    // hopeful than the last twenty — end it and give the credits back.
    if (Date.now() - Date.parse(job.created_at) > GIVE_UP_AFTER_MS) {
      await failJobAndRefund(store, job,
        'The image service stayed busy longer than we are willing to keep you waiting. Your credits have been returned — please try again.', env);
      abandoned++;
      continue;
    }
    const photo = await store.photoById(job.photo_id).catch(() => null);
    if (!photo) {
      // The photograph is gone, so there is nothing left to retry. Finish the
      // job honestly rather than sweeping it forever.
      await failJobAndRefund(store, job, 'That photo is no longer available, so the job was stopped. Your credits have been returned.', env);
      continue;
    }
    await dispatchToPipeline(env, job, photo, store);
  }
  return { claimed: due.length, revived: revive.length, abandoned, timedOut };
}

const RATE_LIMITED_ROUTES = Object.freeze({
  '/api/signin': 'LIMIT_AUTH',     // 10 / minute / IP
  '/api/signup': 'LIMIT_AUTH',
  '/api/auth/apple': 'LIMIT_AUTH', // the iOS app's Sign in with Apple — same door, same limit
  '/api/auth/google/exchange': 'LIMIT_AUTH', // the iOS app swapping its Google code for a session
  '/api/me': 'LIMIT_AUTH',        // DELETE only (account deletion); GET is never limited
  '/api/redeem': 'LIMIT_REDEEM',   // 5 / minute / IP
  '/api/support': 'LIMIT_SUPPORT', // 3 / minute / IP
});
async function rateLimited(env, request, path, method) {
  if (method !== 'POST' && method !== 'DELETE') return null;
  const binding = RATE_LIMITED_ROUTES[path];
  if (!binding) return null;
  if (!env[binding] || typeof env[binding].limit !== 'function') { console.warn('rate limiter binding missing', binding, typeof env[binding]); return null; }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    const { success } = await env[binding].limit({ key: `${path}:${ip}` });
    if (success) return null;
    console.warn('rate limit refused', path, ip);
  } catch (err) {
    console.error('rate limiter unavailable', path, err?.message || err);
    return null;
  }
  return json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts — please wait a minute and try again.' } },
    { status: 429, headers: { 'retry-after': '60' } });
}

/**
 * Tell the account's phones a job finished (push, 10 Sep 2026). A courtesy
 * on top of the polling the app already does: nothing here can fail the
 * job, and with no APNs key configured it does nothing at all. A token
 * Apple declares dead is forgotten so it is never tried again.
 */
export async function notifyJobFinished(env, store, job, ctx = null) {
  if (!pushConfigured(env) || !job?.account_id) return;
  const work = (async () => {
    try {
      const devices = await store.devicesForAccount(job.account_id);
      const body = jobFinishedMessage(job);
      for (const device of devices) {
        let out = await sendPush(env, device, { body, jobId: job.id });
        // A token the app filed under the wrong one of Apple's two services
        // (an Xcode build that said production, say) answers BadDeviceToken:
        // try the other once and, if that works, remember it (a lesson from
        // the Horizon Home Media app).
        if (out.reason === 'BadDeviceToken') {
          const other = device.environment === 'sandbox' ? 'production' : 'sandbox';
          const retry = await sendPush(env, { ...device, environment: other }, { body, jobId: job.id });
          if (retry.ok) {
            await store.putDevice({ token: device.token, accountId: device.account_id, environment: other, at: nowISO() });
            continue;
          }
        }
        if (out.gone) await store.deleteDevice(device.token);
      }
    } catch (err) { console.error('push fan-out failed', job.id, err?.message || err); }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
}

/** `POST /api/devices` { token, environment } — the app registering a phone. */
async function registerDevice(request, account, store) {
  const body = await readJson(request);
  const token = String(body.token || '').toLowerCase();
  const environment = body.environment === 'sandbox' ? 'sandbox' : 'production';
  if (!/^[0-9a-f]{32,400}$/.test(token)) return fail(400, 'DEVICE_TOKEN_REQUIRED', 'That device token is not one Apple would issue.');
  await store.putDevice({ token, accountId: account.id, environment, at: nowISO() });
  return json({ ok: true });
}

/** Finish a job as failed and put the credits back. Safe to call twice. `env` (optional) lets the phones be told. */
export async function failJobAndRefund(store, job, note, env = null) {
  try {
    /**
     * THE REFUND RACE (audit, 3 Sep 2026). finishJob is atomic — only the first
     * finisher writes — but the refund used to follow regardless of who won.
     * A sweep deciding a job was stalled at the same moment its real result
     * landed would lose the finish and still return the credits: photo AND
     * money. Now the refund is gated on actually having finished the job, and
     * the ledger is told the truth about delivery so its own guard can fire.
     */
    const { changed, job: now } = await store.finishJob({ jobId: job.id, status: 'failed', rejectionNote: note, at: nowISO() });
    if (!changed && now && now.status === 'delivered') {
      console.warn('refund skipped: job delivered before the sweep could fail it', job.id);
      return;
    }
    const ledger = await store.ledgerFor(job.account_id);
    const { entry, applied } = ledger.returnCreditsForJob({
      key: `${job.id}:return`, jobId: job.id, reason: note, at: nowISO(),
      delivered: !!(now && now.status === 'delivered'),
    });
    if (applied) await store.appendEntry(job.account_id, { ...entry, jobId: job.id });
    if (changed && env) await notifyJobFinished(env, store, { ...job, status: 'failed' });
  } catch (err) {
    console.error('could not fail and refund', job.id, err?.code || err?.message || err);
  }
}

async function route(request, url, env, ctx, store) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // The webhook is first and is NOT session-authenticated — Stripe has no cookie.
  // Its signature is its identity.
  if (path === '/api/stripe/webhook' && method === 'POST') return stripeWebhook(request, env, ctx, store);

  // The container reporting a finished job. Also not session-authenticated — it
  // carries a shared secret instead, because it is our own code, not a browser.
  const resultMatch = path.match(/^\/internal\/jobs\/([A-Za-z0-9_-]+)\/result$/);
  if (resultMatch && method === 'POST') return pipelineResult(resultMatch[1], request, env, store, ctx);

  // The container's pulse — see HB_STALE_MS. Same shared-secret guard as the
  // result callback; a finished job ignores late beats at the database.
  const hbMatch = path.match(/^\/internal\/jobs\/([A-Za-z0-9_-]+)\/heartbeat$/);
  if (hbMatch && method === 'POST') {
    if (!env.PIPELINE_SECRET || request.headers.get('x-pipeline-secret') !== env.PIPELINE_SECRET) {
      return fail(401, 'NOT_AUTHORISED', 'Rejected.');
    }
    await store.recordHeartbeat(hbMatch[1], nowISO()).catch(() => {});
    return json({ ok: true });
  }

  // How the container reads the original photo. Guarded by the same shared
  // secret; it is not reachable with a session cookie and never listed anywhere.
  const internalPhoto = path.match(/^\/internal\/photos\/(.+)$/);
  if (internalPhoto && method === 'GET') {
    if (!env.PIPELINE_SECRET || url.searchParams.get('s') !== env.PIPELINE_SECRET) {
      return fail(404, 'NOT_FOUND', 'No such photo.');
    }
    const object = await env.PHOTOS.get(decodeURIComponent(internalPhoto[1]));
    if (!object) return fail(404, 'NOT_FOUND', 'No such photo.');
    return new Response(object.body, {
      headers: { 'content-type': object.httpMetadata?.contentType || 'image/jpeg' },
    });
  }

  /**
   * Google, reached from here instead of from the container.
   *
   * WHY THIS EXISTS
   * Google geolocates the caller and refuses whole regions:
   *
   *   400 FAILED_PRECONDITION — "User location is not supported for the API use."
   *
   * Every pipeline job died on that. The identical request from this Worker
   * returned 200 in the same minute, on the same key — so it is the container's
   * egress address Google objects to, not the account. Pinning the container to
   * North America did not fix it, because placement is not egress.
   *
   * So the container calls this, and this calls Google. Two things fall out of
   * that beyond the fix: the Gemini key now lives ONLY in the Worker and never
   * enters the container, and every AI call the product makes passes through one
   * place that can be logged, throttled or swapped for another provider.
   *
   * Guarded by the shared pipeline secret. It is an open proxy to a paid API
   * otherwise.
   */
  if (path.startsWith('/internal/gemini/') && method === 'POST') {
    // The pipeline sends its credential in `x-goog-api-key` (it thinks it is
    // talking to Google), so accept the shared secret from either header.
    const offered = request.headers.get('x-pipeline-secret') || request.headers.get('x-goog-api-key');
    if (!env.PIPELINE_SECRET || offered !== env.PIPELINE_SECRET) {
      return fail(404, 'NOT_FOUND', 'Not found.');
    }
    // Only the two endpoints the pipeline actually uses. A general-purpose
    // passthrough would let anything with the secret reach anything at Google.
    const tail = path.slice('/internal/gemini/'.length);
    if (!/^models\/[A-Za-z0-9._-]+:generateContent$/.test(tail) && tail !== 'interactions') {
      return fail(404, 'NOT_FOUND', 'Not found.');
    }
    // The keepalive envelope this used to offer is GONE — it was built on a wrong
    // diagnosis and measured out of existence. See proxyToGoogle.
    return proxyToGoogle(tail, request, env);
  }

  /**
   * One read-only question, asked of the container itself: can it reach Google
   * directly today? The whole Worker-in-the-middle arrangement exists because it
   * could not on 25 Aug, and that detour is what imposes Cloudflare's 125-second
   * ceiling on every generation — the thing that killed three jobs. If the block
   * has lifted, the detour and the ceiling both go.
   *
   * Guarded by its own secret so it can be asked without the pipeline's, and it
   * spends nothing: the container asks Google with a deliberately invalid key and
   * reports only which refusal came back.
   */
  /**
   * GRADING — Kyle's tool, not the customer's.
   *
   * Not linked from the app and never will be. Guarded by DIAG_SECRET rather than
   * a session, because it reaches across accounts by design: it is measuring the
   * SYSTEM, not serving a customer.
   *
   * Why it exists: the pass rate has been measured on six photographs, one of
   * which had a pathological corner that produced a third of all the complaints.
   * That is not a measurement. Sixty graded photographs turn it into one — and
   * more importantly turn every future change from a coin flip into something
   * that can be re-run and compared.
   */
  /**
   * The owner's dashboard — the design Kyle approved on 22 Aug, served with
   * live numbers. Same gate as the grader: the secret in the URL, a 404
   * without it, and never linked from anything a customer sees.
   */
  if (path.startsWith('/internal/board')) {
    // Wrong or missing secret gets the same 404 as a path that does not exist —
    // the board's address reveals nothing.
    const owner = await ownerAccess(request, url, env);
    if (!owner) return fail(404, 'NOT_FOUND', 'Not found.');
    if (owner.redirect) return owner.redirect;
    // What the rendered pages carry in their own links: nothing once the
    // cookie is doing the work; the secret only when it arrived by URL and the
    // page was fetched by something that is not a browser (curl of the HTML).
    const pageSecret = owner.via === 'cookie' ? '' : env.DIAG_SECRET;
    if (path === '/internal/board' && method === 'GET') {
      const m = await store.boardMetrics();
      const label = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      const short = iso => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
      const T_LABEL = { declutter: 'Declutter', staging: 'Virtual Staging', twilight: 'Twilight', empty: 'Empty Room' };
      const admin = {
        period: 'Last 12 weeks',
        weeks: m.weeks.map(label),
        series: [
          { key: 'declutter', label: 'Declutter', color: 'var(--s1)', hex: '#4E8FD0', values: m.perTransformation.declutter },
          { key: 'staging', label: 'Virtual Staging', color: 'var(--s2)', hex: '#1BAF7A', values: m.perTransformation.staging },
          { key: 'twilight', label: 'Twilight', color: 'var(--s3)', hex: '#E0632F', values: m.perTransformation.twilight },
          { key: 'empty', label: 'Empty Room', color: 'var(--s4, #8FBEE8)', hex: '#8FBEE8', values: m.perTransformation.empty },
        ],
        kpis: {
          revenue: m.revenueCents / 100,
          revenueDelta: `${m.creditsSold} credits sold in the period`,
          creditsSold: m.creditsSold,
          creditsUsed: m.creditsUsed,
          // MEASURED, not estimated (since 28 Aug 2026): every job's finish
          // writes its real Google spend from the container's meter onto the
          // job row, rejections included. Jobs from before the meter existed
          // are covered by the measured-average estimate so the total never
          // silently under-reports; post-launch (after the test-data wipe)
          // every job is metered and the estimate term is zero.
          aiCost: +(m.realCostUsd + m.unmeteredJobs * 0.45).toFixed(2),
          passRate: m.passRate ?? 100,
          rejected: m.rejected,
        },
        revenueSpark: m.revenueByWeek,
        failures: m.failures.map(f => ({
          date: short(f.created_at),
          listing: f.address || '—',
          type: T_LABEL[f.transformation] || f.transformation,
          reason: f.rejection_note || 'No result passed the compliance checks.',
          action: 'Credits returned',
        })),
        customers: m.customers.map(c => ({
          name: c.email, org: '', tx: c.tx || 0, credits: c.credits || 0, last: short(c.last),
        })),
        audit: m.audit.map(a => ({
          ts: short(a.created_at),
          listing: a.address || '—',
          photo: a.room_type || '—',
          type: T_LABEL[a.transformation] || a.transformation,
          opts: [a.style, a.room_type].filter(Boolean).join(' · ') || '—',
          attempts: a.attempts_used,
          result: a.status === 'delivered' ? 'pass' : (a.status === 'rejected' || a.status === 'failed') ? 'fail' : a.status,
          cost: a.refunded ? 0 : (a.debit || 0),
        })),
      };
      const svc = {
        salesPaused: await store.getFlag('salesPaused'),
        genPaused: await store.getFlag('genPaused'),
      };
      // Owner nav: the promo and report screens are separate pages, and the
      // dashboard is where Kyle lands — so the doors to them live here, floating
      // bottom-right, carrying the secret along. (Added 29 Aug after Kyle
      // couldn't find the mint screen from the dashboard.)
      const s = encodeURIComponent(pageSecret);
      const ownerNav = `<div style="position:fixed;right:14px;bottom:14px;z-index:90;display:flex;gap:8px;font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
        <a href="/internal/board/live?s=${s}" style="background:#131A24;border:1px solid #2E5A8F;color:#8FD0A8;text-decoration:none;padding:10px 14px;border-radius:99px;box-shadow:0 3px 12px rgba(0,0,0,.35)">Live</a>
        <a href="/internal/board/deliveries?s=${s}" style="background:#131A24;border:1px solid #293546;color:#6EA5E1;text-decoration:none;padding:10px 14px;border-radius:99px;box-shadow:0 3px 12px rgba(0,0,0,.35)">Deliveries</a>
        <a href="/internal/board/promos?s=${s}" style="background:#131A24;border:1px solid #293546;color:#6EA5E1;text-decoration:none;padding:10px 14px;border-radius:99px;box-shadow:0 3px 12px rgba(0,0,0,.35)">Promo codes</a>
        <a href="/internal/board/reports?s=${s}" style="background:#131A24;border:1px solid #293546;color:#6EA5E1;text-decoration:none;padding:10px 14px;border-radius:99px;box-shadow:0 3px 12px rgba(0,0,0,.35)">Reports</a>
      </div></body>`;
      // Escape '<' (and the line separators JSON leaves raw) before embedding
      // JSON in a <script>, so a customer email containing "</script>…" cannot
      // break out of the data block. Belt to the board page's own esc() on
      // render; suspenders here at the source. (Security review, 31 Aug 2026.)
      const forScript = obj => JSON.stringify(obj)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
      const page = BOARD_PAGE
        .replace('__ADMIN_DATA__', forScript(admin))
        .replace('__SVC_DATA__', forScript(svc))
        .replace('__BOARD_SECRET__', forScript(pageSecret))
        .replace('</body>', ownerNav);
      return new Response(page, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // A single missed escape can't become code exfiltration: scripts run
          // only from this origin, and no external connections are allowed.
          'content-security-policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
        },
      });
    }
    // The live view — see live-page.js. The beta's window into "is it running
    // and why not": every job from the last 24h, errors in plain English.
    if (path === '/internal/board/live' && method === 'GET') {
      return new Response(livePage(pageSecret), {
        headers: { 'content-type': 'text/html; charset=utf-8',
                   'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'",
                   'referrer-policy': 'no-referrer' },
      });
    }
    /**
     * THE DEPLOY CYCLE (2 Sep 2026): POST here after every deploy — each pool
     * slot is told to finish its current job and exit, so the whole fleet
     * boots fresh on the new image within minutes instead of lingering on a
     * mix of versions (the poisoned-slots incident). Safe mid-traffic:
     * draining instances refuse new work (the probe skips them) and running
     * jobs finish before the exit.
     */
    if (path === '/internal/board/cycle' && method === 'POST') {
      const out = [];
      for (let i = 0; i < JOB_POOL_SIZE; i++) {
        const name = `pipeline-${i}`;
        try {
          const c = env.PIPELINE.get(env.PIPELINE.idFromName(name));
          const r = await c.fetch('https://pipeline.internal/cycle', { method: 'POST' });
          out.push({ slot: name, status: r.status, body: await r.json().catch(() => null) });
        } catch (e) {
          out.push({ slot: name, error: String(e && e.message || e).slice(0, 100) });
        }
      }
      // The classify slot cycles too — same class, its own name.
      try {
        const c = env.PIPELINE.get(env.PIPELINE.idFromName('classify'));
        const r = await c.fetch('https://pipeline.internal/cycle', { method: 'POST' });
        out.push({ slot: 'classify', status: r.status });
      } catch (e) { out.push({ slot: 'classify', error: String(e && e.message || e).slice(0, 100) }); }
      return json({ cycled: out });
    }

    if (path === '/internal/board/slots.json' && method === 'GET') {
      return json({ slots: await store.slotHealth().catch(() => []) });
    }

    if (path === '/internal/board/live.json' && method === 'GET') {
      return json(await liveJobsJson(env));
    }
    // One job's full story — the tap-to-open detail: images (original, the
    // refused frame, the delivery) and every attempt with the judges'
    // objections verbatim.
    if (path === '/internal/board/live/job.json' && method === 'GET') {
      const detail = await liveJobJson(env, url.searchParams.get('id') || '');
      if (!detail) return fail(404, 'NOT_FOUND', 'No such job.');
      return json(detail);
    }
    if (path === '/internal/board/flags' && method === 'POST') {
      const body = await readJson(request);
      if (!['salesPaused', 'genPaused'].includes(body.key)) return fail(400, 'UNKNOWN_FLAG', 'Not a switch this board offers.');
      await store.setFlag(body.key, body.value === true);
      return json({ ok: true, [body.key]: body.value === true });
    }
    // Mint a promo code (owner only — same secret as the board). Body:
    // { credits, code?, maxUses?, note?, expiresAt? }. Omit `code` for a
    // generated one. Codes are stored and matched uppercase.
    if (path === '/internal/board/promo' && method === 'POST') {
      const body = await readJson(request);
      const credits = body.credits;
      if (!Number.isInteger(credits) || credits <= 0 || credits > 500) {
        return fail(400, 'INVALID_CREDITS', 'credits must be a whole number between 1 and 500.');
      }
      const maxUses = body.maxUses ?? 1;
      if (!Number.isInteger(maxUses) || maxUses <= 0 || maxUses > 10000) {
        return fail(400, 'INVALID_USES', 'maxUses must be a whole number between 1 and 10000.');
      }
      const code = String(body.code || `LL-${randomId(6)}`).trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
        return fail(400, 'INVALID_CODE', 'Codes are 4–32 letters, numbers and dashes.');
      }
      try {
        await store.createPromoCode({
          code, credits, maxUses,
          note: body.note ?? null, expiresAt: body.expiresAt ?? null, at: nowISO(),
        });
      } catch (e) {
        return fail(409, 'CODE_EXISTS', 'That code already exists.');
      }
      return json({ ok: true, code, credits, maxUses }, { status: 201 });
    }
    /**
     * ERASE A CUSTOMER (the privacy policy, 3 Sep 2026). POST {email, confirm}
     * with confirm === email. Deletes every R2 object the account owns and
     * every photo/job/session row; keeps the ledger and Stripe records the
     * policy names as the exception; anonymises the account. Owner-only,
     * behind the board secret, and it refuses without the typed confirmation
     * because there is no undo.
     */
    if (path === '/internal/board/erase-account' && method === 'POST') {
      const body = await readJson(request);
      let email;
      try { email = normaliseEmail(String(body.email || '')); } catch { return fail(400, 'INVALID_EMAIL', 'A valid email is required.'); }
      if (String(body.confirm || '').trim().toLowerCase() !== email) return fail(400, 'CONFIRM_REQUIRED', 'Type the email again in "confirm" to erase.');
      const account = await store.accountByEmail(email);
      if (!account) return fail(404, 'NOT_FOUND', 'No account with that email.');
      const erased = await store.eraseAccountData(account.id, nowISO());
      let deleted = 0, failed = 0;
      for (const key of erased.keys) {
        try { await env.PHOTOS.delete(key); deleted++; } catch { failed++; }
      }
      console.warn('account erased', account.id, `${erased.photos} photos, ${erased.jobs} jobs, ${deleted} objects`);
      return json({ ok: true, accountId: account.id, photos: erased.photos, jobs: erased.jobs, objectsDeleted: deleted, objectsFailed: failed });
    }
    if (path === '/internal/board/promo' && method === 'GET') {
      const rows = await store.listPromoCodes();
      const redeemed = await store.promoRedemptions();
      return json({ codes: rows.map(r => ({
        code: r.code, credits: r.credits, uses: r.uses, maxUses: r.max_uses,
        note: r.note, expiresAt: r.expires_at,
        redeemedBy: redeemed[r.code] || [],
      })) });
    }
    // The owner's promo screen: mint codes, see who used what. Same secret,
    // same 404-without-it as the rest of the board.
    if (path === '/internal/board/promos' && method === 'GET') {
      return new Response(PROMOS_HTML.replace('__SECRET__', pageSecret), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // Owner-only image proxy: the board pages show customer photos, and R2
    // keys are only reachable through account-scoped routes otherwise. Inside
    // this block, so the same wrong-secret-is-a-404 rule applies.
    if (path === '/internal/board/img' && method === 'GET') {
      const obj = await env.PHOTOS.get(url.searchParams.get('key') || '');
      if (!obj) return fail(404, 'NOT_FOUND', 'Not found.');
      return new Response(obj.body, {
        headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=3600' },
      });
    }
    // Every delivery to a real customer, original beside result (31 Aug 2026:
    // "as far as seeing all the delivered images to real clients against the
    // originals, is that not possible right now?" — now it is).
    if (path === '/internal/board/deliveries' && method === 'GET') {
      const rows = await store.deliveredForBoard(200);
      const s = encodeURIComponent(pageSecret);
      const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const img = key => `/internal/board/img?s=${s}&key=${encodeURIComponent(key)}`;
      const T_LABEL = { declutter: 'Declutter', staging: 'Virtual Staging', twilight: 'Twilight', empty: 'Empty Room' };
      // Grouped per customer, filterable, and every job addressable by #anchor —
      // built for the day this is hundreds of rows and one specific complaint.
      const byEmail = new Map();
      for (const r of rows) {
        if (!byEmail.has(r.email)) byEmail.set(r.email, []);
        byEmail.get(r.email).push(r);
      }
      const groups = [...byEmail.entries()].map(([email, jobs]) => {
        const cards = jobs.map(r => {
          const variants = r.variant_keys ? JSON.parse(r.variant_keys) : [];
          const label = T_LABEL[r.transformation] || r.transformation;
          const hay = esc([r.id, email, label, r.style, r.room_type].filter(Boolean).join(' ').toLowerCase());
          return `<div class="row" id="${esc(r.id)}" data-t="${esc(r.transformation)}" data-hay="${hay}">
            <div class="meta"><b>${esc(label)}</b>
              ${r.style ? ' · ' + esc(r.style) : ''}${r.room_type ? ' · ' + esc(r.room_type) : ''}
              · ${esc((r.finished_at || '').slice(0, 16).replace('T', ' '))}
              <span class="jid">${esc(r.id)}</span></div>
            <div class="pair">
              <figure><img src="${img(r.original_key)}" loading="lazy"
                onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg',textContent:'HEIC original — no browser preview'}))"><figcaption>Original</figcaption></figure>
              <figure><img src="${img(r.result_key)}" loading="lazy"><figcaption>Delivered</figcaption></figure>
              ${variants.map((k, i) => `<figure><img src="${img(k)}" loading="lazy"><figcaption>Version ${i + 2}</figcaption></figure>`).join('')}
            </div>
          </div>`;
        }).join('');
        return `<details class="cust" open data-email="${esc(email.toLowerCase())}">
          <summary>${esc(email)} <span class="count">${jobs.length} deliver${jobs.length === 1 ? 'y' : 'ies'}</span></summary>
          ${cards}
        </details>`;
      }).join('') || '<p class="empty">No customer deliveries yet.</p>';
      const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Deliveries — Listing Lab</title><style>
  body{margin:0;background:#0C1118;color:#E9EDF3;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:22px}
  h1{font-size:22px;margin:0 0 4px}.sub{color:#A0ABBA;font-size:13.5px;margin:0 0 14px}.sub a{color:#6EA5E1}
  .bar{position:sticky;top:0;z-index:5;background:rgba(12,17,24,.94);backdrop-filter:blur(8px);
       display:flex;gap:8px;padding:10px 0 12px;border-bottom:1px solid #293546;margin-bottom:6px}
  .bar input,.bar select{background:#131A24;border:1px solid #293546;color:#E9EDF3;border-radius:8px;padding:9px 12px;font-size:14px}
  .bar input{flex:1;min-width:0}
  details.cust{border-top:1px solid #293546;padding:4px 0}
  summary{cursor:pointer;padding:12px 0;font-weight:600;font-size:15px}
  .count{color:#6B7787;font-weight:400;font-size:13px;margin-left:8px}
  .row{padding:10px 0 16px}
  .row.hit{outline:2px solid #6EA5E1;outline-offset:6px;border-radius:12px}
  .meta{font-size:13.5px;color:#A0ABBA;margin-bottom:10px}.meta b{color:#E9EDF3}
  .jid{color:#3E4A5C;font-size:11.5px;margin-left:8px;user-select:all}
  .pair{display:flex;gap:8px;flex-wrap:wrap}
  figure{margin:0;flex:1 1 300px;max-width:520px}
  img{width:100%;border-radius:10px;display:block}
  figcaption{font-size:12px;color:#6B7787;margin-top:4px}
  .noimg{display:flex;align-items:center;justify-content:center;background:#131A24;border:1px solid #293546;border-radius:10px;min-height:200px;color:#6B7787;font-size:13px}
  .empty{color:#6B7787}
</style></head><body>
  <h1>Deliveries</h1>
  <p class="sub">Grouped by customer, newest first, latest 200. Paste a job id from a report to jump straight to it.
    <a href="/internal/board?s=${s}">Back to dashboard</a></p>
  <div class="bar">
    <input id="q" type="search" placeholder="Search email, job id, room, style…">
    <select id="t"><option value="">All types</option>
      <option value="declutter">Declutter</option><option value="empty">Empty Room</option>
      <option value="staging">Virtual Staging</option><option value="twilight">Twilight</option></select>
  </div>
  ${groups}
<script>
  const q = document.getElementById('q'), t = document.getElementById('t');
  function apply(){
    const needle = q.value.trim().toLowerCase(), type = t.value;
    document.querySelectorAll('details.cust').forEach(g => {
      let any = false;
      g.querySelectorAll('.row').forEach(r => {
        const ok = (!type || r.dataset.t === type) &&
                   (!needle || r.dataset.hay.includes(needle) || g.dataset.email.includes(needle));
        r.style.display = ok ? '' : 'none';
        if (ok) any = true;
      });
      g.style.display = any ? '' : 'none';
      if (needle && any) g.open = true;
    });
  }
  q.oninput = apply; t.onchange = apply;
  // Arriving from a report: open the group, glow the row.
  if (location.hash.length > 1) {
    const row = document.getElementById(location.hash.slice(1));
    if (row) {
      row.closest('details').open = true;
      row.classList.add('hit');
      row.scrollIntoView({ block: 'center' });
    }
  }
</script>
</body></html>`;
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    // Customer problem reports — the list, the page, and the resolve button.
    if (path === '/internal/board/reports.json' && method === 'GET') {
      const rows = await store.listReports();
      return json({ reports: rows.map(r => ({
        id: r.id, status: r.status, message: r.message, at: r.created_at,
        customer: { email: r.email, name: r.account_name },
        job: { id: r.job_id, transformation: r.transformation, status: r.job_status,
               note: r.rejection_note, costUsd: r.cost_usd, at: r.job_created_at },
      })) });
    }
    if (path === '/internal/board/reports/resolve' && method === 'POST') {
      const body = await readJson(request);
      const done = await store.resolveReport(String(body.id || ''), nowISO());
      return done ? json({ ok: true }) : fail(404, 'NOT_FOUND', 'No open report with that id.');
    }
    if (path === '/internal/board/reports' && method === 'GET') {
      return new Response(REPORTS_HTML.replace('__SECRET__', pageSecret), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return fail(404, 'NOT_FOUND', 'Not found.');
  }

  const grader = path.startsWith('/internal/grade') ? await ownerAccess(request, url, env) : null;
  if (grader) {
    if (grader.redirect) return grader.redirect;
    const pageSecret = grader.via === 'cookie' ? '' : env.DIAG_SECRET;
    if (path === '/internal/grade' && method === 'GET') {
      return new Response(GRADER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/internal/grade/jobs' && method === 'GET') {
      // ?since=YYYY-MM-DD — grade one day's crop without wading through the
      // all-time backlog first.
      // A date grades one day's crop; a full timestamp (…T02:20:00Z) grades
      // one batch out of a busy day (4 Sep 2026: three batches in one night).
      const since = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/.test(url.searchParams.get('since') || '') ? url.searchParams.get('since') : null;
      const rows = await store.gradingQueue(300, since);
      return json({
        jobs: rows.map(r => ({
          jobId: r.id,
          transformation: r.transformation,
          style: r.style, roomType: r.room_type,
          // What the SYSTEM decided — sent, but the page must not show it until
          // he has answered. Seeing "we rejected this" first anchors the verdict,
          // and an anchored grade measures nothing.
          systemVerdict: r.status,
          systemNote: r.rejection_note,
          beforeUrl: r.original_key ? `/internal/grade/photo?s=${encodeURIComponent(pageSecret)}&k=${encodeURIComponent(r.original_key)}` : null,
          afterUrl: (r.result_key || r.reject_key)
            ? `/internal/grade/photo?s=${encodeURIComponent(pageSecret)}&k=${encodeURIComponent(r.result_key || r.reject_key)}` : null,
          myVerdict: r.verdict || null,
          myNote: r.grade_note || null,
        })),
      });
    }
    if (path === '/internal/grade/photo' && method === 'GET') {
      const key = url.searchParams.get('k');
      if (!key) return fail(404, 'NOT_FOUND', 'Not found.');
      const obj = await env.PHOTOS.get(key);
      if (!obj) return fail(404, 'NOT_FOUND', 'Not found.');
      return new Response(obj.body, {
        headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=3600' },
      });
    }
    const gradeMatch = path.match(/^\/internal\/grade\/([A-Za-z0-9_-]+)$/);
    if (gradeMatch && method === 'POST') {
      const body = await readJson(request);
      if (!['pass', 'fail', 'wrong_job'].includes(body.verdict)) {
        return fail(400, 'BAD_REQUEST', 'verdict must be pass, fail or wrong_job.');
      }
      await store.saveGrade({ jobId: gradeMatch[1], verdict: body.verdict, note: body.note || null, at: nowISO() });
      return json({ ok: true });
    }
  }

  if (path === '/internal/diag/egress' && method === 'GET') {
    if (!env.DIAG_SECRET || url.searchParams.get('s') !== env.DIAG_SECRET) {
      return fail(404, 'NOT_FOUND', 'Not found.');
    }
    const container = env.PIPELINE.get(env.PIPELINE.idFromName('pipeline-0'));
    const res = await container.fetch('http://container/diag/egress');
    return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
  }

  /**
   * RATE LIMITS (audit, 3 Sep 2026). Four routes were open to anyone at any
   * rate: sign-in (credential stuffing), sign-up (each call burns 100k PBKDF2
   * iterations of Worker CPU), redeem (four-character codes brute-force in
   * seconds — free credits), and support (a public relay into the owner's
   * inbox). Cloudflare's Workers rate limiter, keyed on the caller's IP; a
   * missing binding (local tests, an old deploy) means no limit rather than
   * a broken door.
   */
  const limited = await rateLimited(env, request, path, method);
  if (limited) return limited;

  if (path === '/api/signup'  && method === 'POST') return signup(request, env, store);
  if (path === '/api/signin'  && method === 'POST') return signin(request, env, store);
  if (path === '/api/signout' && method === 'POST') return signout(request, env, store);
  // Sign in with Apple from the iOS app. Public by necessity, like the two
  // above: the identity token in the body is what proves who is asking.
  if (path === '/api/auth/apple' && method === 'POST') return appleSignIn(request, env, store);

  // Google sign-in. The button only shows when the OAuth client is configured,
  // so the app asks first. Both legs are public by necessity — nobody is signed
  // in yet when they run.
  if (path === '/api/auth/config' && method === 'GET') {
    return json({ google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
  }
  if (path === '/api/auth/google' && method === 'GET') return googleStart(env, url);
  if (path === '/api/auth/google/callback' && method === 'GET') {
    return googleCallback(request, url, env, store);
  }
  // The iOS app's third leg: it swaps the one-time code the callback handed
  // it for a session. Public like the two above; the code and the secret
  // behind it are what prove who is asking.
  if (path === '/api/auth/google/exchange' && method === 'POST') return googleExchange(request, env, store);

  // The web client itself is public — it HAS to be, because it is where the
  // sign-in form lives. Putting this after the auth gate below serves a signed-out
  // visitor a 401 instead of the page they sign in on.
  if (!path.startsWith('/api/') && !path.startsWith('/internal/')) {
    // /pricing is a section of the landing page, not a page of its own. Send
    // the address people (and crawlers) guess to the section rather than
    // serving a second copy of the homepage under a different name.
    if (path === '/pricing' || path === '/pricing/') {
      return Response.redirect(new URL('/#pricing', url.origin).toString(), 301);
    }
    // Where Stripe sends the iPhone app's customer after Checkout: a page
    // whose only job is to hand back to the app. Served by name so the
    // address Stripe returns to is one path, not a file.
    if (path === '/purchase/return' && env.ASSETS) {
      const page = new URL('/purchase-return.html', url.origin);
      page.search = url.search;
      return env.ASSETS.fetch(new Request(page.toString(), request));
    }
    // Where Google's callback sends the iPhone app's customer after signing
    // in: the same kind of page, handing the app its one-time code.
    if (path === '/signin/return' && env.ASSETS) {
      const page = new URL('/signin-return.html', url.origin);
      page.search = url.search;
      return env.ASSETS.fetch(new Request(page.toString(), request));
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fail(404, 'NOT_FOUND', 'Not found.');
  }

  // Support is deliberately OUTSIDE the auth gate: a person who cannot sign in
  // is exactly the person who most needs to reach a human. The account, when
  // there is one, rides along for context. (Kyle, 29 Aug: the mailto link is a
  // dead end on phones with no mail app configured.)
  if (path === '/api/support' && method === 'POST') {
    const acct = await currentAccount(request, store);
    return supportMessage(request, env, acct);
  }

  // Everything below needs a signed-in account.
  const account = await currentAccount(request, store);
  if (!account) return fail(401, 'NOT_SIGNED_IN', 'Sign in to continue.');

  if (path === '/api/me'       && method === 'GET')  return json({ account: publicAccount(account) });
  if (path === '/api/me'       && method === 'DELETE') return deleteAccount(request, env, account, store);
  if (path === '/api/jobs'     && method === 'GET')  return jobList(account, store);
  if (path === '/api/credits'  && method === 'GET')  return credits(account, store);
  if (path === '/api/packs'    && method === 'GET')  return json({ packs: CREDIT_PACKS });
  if (path === '/api/redeem'   && method === 'POST') return redeemPromo(request, account, store);
  if (path === '/api/report'   && method === 'POST') return fileReport(request, account, store);
  if (path === '/api/checkout' && method === 'POST') return startCheckout(request, env, account, store);
  if (path === '/api/transform'&& method === 'POST') return startTransform(request, env, ctx, account, store);

  if (path === '/api/photos' && method === 'POST') return uploadPhoto(request, env, ctx, account, store);
  if (path === '/api/photos/from-job' && method === 'POST') return photoFromJob(request, env, ctx, account, store);
  // The room-reading result, pollable. Uploads answer the moment the bytes are
  // stored (1 Sep 2026 — the bar sat at 100% for the length of a vision call,
  // plus a cold container on the first photo); the app asks here a moment
  // later and fills in the right buttons. Registered before the image route so
  // /scene is never mistaken for an object key.
  const sceneMatch = path.match(/^\/api\/photos\/(pho_[A-Za-z0-9]+)\/scene$/);
  if (sceneMatch && method === 'GET') {
    const p = await store.photoById(sceneMatch[1]);
    if (!p || p.account_id !== account.id) return fail(404, 'NOT_FOUND', 'No such photo.');
    let signals = null;
    try { signals = p.scene ? JSON.parse(p.scene) : null; } catch {}
    const offers = offeredFor(signals);
    return json({ ready: !!signals, signals, offers,
      advice: Object.fromEntries(offers.map(t => [t, adviceFor(signals, t)]).filter(([, a]) => a)) });
  }

  // The whole set in one file (9 Sep 2026, Kyle: "group download from the My
  // Photos page"). Checked before the job route below so "zip" is never read
  // as a job id.
  if (path === '/api/jobs/zip' && method === 'GET') return jobsZip(url, account, env, store);

  // The iPhone app's push registration (10 Sep 2026): a phone that wants to
  // hear when a photo finishes, and the same phone forgetting itself at sign-out.
  if (path === '/api/devices' && method === 'POST') return registerDevice(request, account, store);
  const deviceMatch = path.match(/^\/api\/devices\/([0-9a-fA-F]{32,400})$/);
  if (deviceMatch && method === 'DELETE') {
    await store.deleteDevice(deviceMatch[1].toLowerCase(), account.id);
    return json({ ok: true });
  }

  const jobMatch = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
  if (jobMatch && method === 'GET') return jobStatus(jobMatch[1], account, store);

  const photoMatch = path.match(/^\/api\/photos\/(.+)$/);
  if (photoMatch && method === 'GET') {
    return servePhoto(decodeURIComponent(photoMatch[1]), env, account,
      url.searchParams.get('download') === '1', url.searchParams.get('preview') === '1');
  }

  return fail(404, 'NOT_FOUND', 'No such endpoint.');
}

/* ------------------------------------------------------------------- accounts */

const publicAccount = a => ({ id: a.id, email: a.email, name: a.name, company: a.company });

async function currentAccount(request, store) {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (!token) return null;
  const session = await store.sessionByHash(await hashToken(token));
  if (!session || isExpired(session)) return null;
  return store.accountById(session.account_id);
}

async function signup(request, env, store) {
  const body = await readJson(request);
  const email = normaliseEmail(body.email);
  const passwordHash = await hashPassword(String(body.password ?? ''));
  const account = await store.createAccount({
    id: `acct_${randomId(12)}`,
    email,
    name: body.name ?? null,
    company: body.company ?? null,
    passwordHash,
    at: nowISO(),
  });
  return startSession(account, env, store, 201);
}

async function signin(request, env, store) {
  const body = await readJson(request);
  let email;
  try { email = normaliseEmail(body.email); }
  catch { return fail(401, 'BAD_CREDENTIALS', 'That email and password do not match.'); }

  const account = await store.accountByEmail(email);

  // Hash even when there is no account, so an unregistered address does not come
  // back noticeably faster than a wrong password. Otherwise the form becomes a
  // way to find out which of an agent's addresses are registered.
  const stored = account?.password_hash ?? '$unused$';
  const ok = await verifyPassword(String(body.password ?? ''), stored);

  if (!account || !ok) {
    // Accounts that were never given a password can never pass the check
    // above — '$google-only$' and '$apple-only$' are markers, not hashes. Tell
    // those people which door to use instead of "do not match", which reads
    // as a typo they will keep retrying (the iOS app, 9 Sep 2026). This does
    // say that the address has an account, and only for these two markers:
    // a plain password account still gets the same answer as an unknown one.
    if (account?.password_hash === '$apple-only$') {
      return fail(401, 'APPLE_ACCOUNT', 'That email signed up with Apple — use Sign in with Apple.');
    }
    if (account?.password_hash === '$google-only$') {
      return fail(401, 'GOOGLE_ACCOUNT', 'That email signed up with Google — sign in with Google.');
    }
    return fail(401, 'BAD_CREDENTIALS', 'That email and password do not match.');
  }
  return startSession(account, env, store);
}

async function startSession(account, env, store, status = 200) {
  const { token, record } = await newSession(account.id);
  await store.putSession(record);
  return json({ account: publicAccount(account) }, {
    status,
    headers: { 'set-cookie': sessionCookie(token, { secure: env.SITE_URL !== 'http://localhost:8787' }) },
  });
}

/* ------------------------------------------------------------ Google sign-in */

/**
 * Standard OAuth authorization-code flow, server side, nothing exotic:
 *
 *   1. /api/auth/google sends the visitor to Google's consent screen with a
 *      random `state` we also set as a short-lived cookie.
 *   2. Google sends them back to /api/auth/google/callback with a code.
 *   3. We swap the code for an id_token DIRECTLY with Google over TLS — because
 *      the token comes straight from Google's own endpoint, its claims are
 *      trustworthy once we check issuer, audience and expiry.
 *   4. Verified email in hand: sign into the existing account with that email,
 *      or create one. Google accounts get an unusable password marker, so the
 *      password form can never be used to enter them.
 *
 * Failures land back on /app with a readable banner code, never a JSON error
 * page — the person on the phone came from a button, not an API client.
 *
 * THE iPHONE APP (10 Sep 2026) walks the same three steps inside a sheet
 * over the app, with one difference at the end. It cannot take a session
 * cookie from a web page, so step 4 hands it a one-time code instead — on
 * /signin/return, a page whose only job is to open listinglab://signin — and
 * the app swaps the code for a session at /api/auth/google/exchange. The
 * code is bound to the app that asked: it starts with `challenge`, the hash
 * of a secret it made up (PKCE, RFC 7636), and the exchange must present
 * that secret. A code that leaked from the phone is useless without it.
 * The app says it is the app with `platform=ios`; both facts ride in the
 * state cookie so the callback needs nothing it did not set itself.
 */
const GSTATE_COOKIE = 'll_gstate';
/** How long the iPhone app has to swap its code for a session. */
const APP_SIGNIN_TTL_MS = 5 * 60 * 1000;
/** base64url of a SHA-256: 43 characters, no padding. */
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function googleRedirectUri(env) { return `${env.SITE_URL}/api/auth/google/callback`; }

function googleStart(env, url) {
  if (!env.GOOGLE_CLIENT_ID) return fail(404, 'NOT_FOUND', 'Google sign-in is not configured.');
  const state = randomId(24);
  let cookieValue = state;
  if (url?.searchParams.get('platform') === 'ios') {
    const challenge = url.searchParams.get('challenge') || '';
    if (!CHALLENGE_SHAPE.test(challenge)) return fail(400, 'CHALLENGE_REQUIRED', 'Google sign-in did not start properly — try again.');
    cookieValue = `${state}.ios.${challenge}`;
  }
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(env),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
      'set-cookie': `${GSTATE_COOKIE}=${cookieValue}; Max-Age=600; Path=/api/auth/google/callback; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function googleCallback(request, url, env, store) {
  // The state cookie is `<state>` for the website and `<state>.ios.<challenge>`
  // for the iPhone app. Read it before anything can fail, so a failure goes
  // back to whichever of the two asked.
  const [cookieState, platform, challenge] = ((request.headers.get('cookie') || '')
    .split(/;\s*/).find(c => c.startsWith(`${GSTATE_COOKIE}=`))?.slice(GSTATE_COOKIE.length + 1) || '').split('.');
  const fromApp = platform === 'ios' && CHALLENGE_SHAPE.test(challenge || '');
  const back = (code) => new Response(null, {
    status: 302,
    headers: {
      location: fromApp
        ? `${env.SITE_URL}/signin/return?error=${code}`
        : `${env.SITE_URL}/app${code ? `?auth_error=${code}` : ''}`,
      'set-cookie': `${GSTATE_COOKIE}=; Max-Age=0; Path=/api/auth/google/callback; HttpOnly; Secure; SameSite=Lax`,
    },
  });
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return back('google_off');

  const state = url.searchParams.get('state');
  if (!state || state !== cookieState) return back('state_mismatch');
  const code = url.searchParams.get('code');
  if (!code) return back('google_denied');

  let idToken;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(env),
        grant_type: 'authorization_code',
      }),
    });
    const tok = await res.json();
    if (!res.ok || !tok.id_token) return back('google_exchange');
    idToken = tok.id_token;
  } catch { return back('google_unreachable'); }

  let claims;
  try {
    claims = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return back('google_token'); }
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== env.GOOGLE_CLIENT_ID) return back('google_token');
  if (!claims.exp || claims.exp * 1000 < Date.now()) return back('google_token');
  if (!claims.email || claims.email_verified !== true) return back('google_email');

  let email;
  try { email = normaliseEmail(claims.email); } catch { return back('google_email'); }
  let account = await store.accountByEmail(email);
  /**
   * NO SILENT MERGE INTO A PASSWORD ACCOUNT (audit, 3 Sep 2026). Signup does
   * not verify email, so anyone can register a victim's address with their
   * own password first; if Google sign-in then landed in that account by
   * address alone, the victim's future uploads and purchases would sit in the
   * attacker's account. A Google login therefore only enters an account that
   * Google created. A password account with the same address is told to use
   * its password — the honest owner loses nothing, the squatter gains nothing.
   */
  if (account && account.password_hash !== '$google-only$') return back('google_password_account');
  if (!account) {
    account = await store.createAccount({
      id: `acct_${randomId(12)}`,
      email,
      name: claims.name ?? null,
      company: null,
      // Not a hash of anything: the password door can never open this account.
      passwordHash: '$google-only$',
      at: nowISO(),
    });
  }
  if (fromApp) {
    // No session yet: the app gets a one-time code and makes the session
    // itself at /api/auth/google/exchange, proving it holds the secret
    // behind `challenge`. Nothing private is set in the sheet's cookies.
    const code = randomId(32);
    const now = Date.now();
    await store.purgeExpiredAppSignins(new Date(now).toISOString());
    await store.putAppSignin({
      code_hash: await hashToken(code),
      account_id: account.id,
      challenge,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + APP_SIGNIN_TTL_MS).toISOString(),
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: `${env.SITE_URL}/signin/return?code=${code}`,
        'set-cookie': `${GSTATE_COOKIE}=; Max-Age=0; Path=/api/auth/google/callback; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }
  const { token, record } = await newSession(account.id);
  await store.putSession(record);
  // Two cookies, so headers.append — a comma-joined Set-Cookie is undefined
  // behaviour and some clients split it wrong.
  const headers = new Headers({ location: `${env.SITE_URL}/app` });
  headers.append('set-cookie', sessionCookie(token, { secure: env.SITE_URL !== 'http://localhost:8787' }));
  headers.append('set-cookie', `${GSTATE_COOKIE}=; Max-Age=0; Path=/api/auth/google/callback; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

/**
 * POST /api/auth/google/exchange — the iPhone app turning its one-time code
 * into a session. Body: { code, verifier }. The code is taken out of the
 * table in the same statement that reads it, so it works exactly once
 * whatever happens next; then it must not have expired, and the SHA-256 of
 * the verifier must be the challenge the app started with. Every refusal is
 * the same 401 with the web's own sentence for a Google sign-in that did
 * not finish — there is nothing useful to tell an impostor.
 */
async function googleExchange(request, env, store) {
  const body = await readJson(request);
  const code = String(body.code || '');
  const verifier = String(body.verifier || '');
  const refuse = () => fail(401, 'GOOGLE_CODE', "Google sign-in didn't finish — try again, or use email and password.");
  if (!/^[0-9a-f]{64}$/.test(code) || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return refuse();

  const row = await store.takeAppSignin(await hashToken(code));
  if (!row) return refuse();
  if (new Date(row.expires_at).getTime() <= Date.now()) return refuse();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (challenge !== row.challenge) return refuse();

  const account = await store.accountById(row.account_id);
  if (!account) return refuse();
  const { token, record } = await newSession(account.id);
  await store.putSession(record);
  return json({ account: publicAccount(account), session: token }, {
    headers: { 'set-cookie': sessionCookie(token, { secure: env.SITE_URL !== 'http://localhost:8787' }) },
  });
}

/* ------------------------------------------------------- Sign in with Apple */

/**
 * Sign in with Apple, from the iOS app (9 Sep 2026).
 *
 * The phone shows Apple's own sheet and hands us the identity token Apple
 * signed. There is no redirect and no state cookie — the token is verified
 * directly against Apple's published keys (src/apple.js): signature, issuer,
 * audience (our bundle id), expiry. Then:
 *
 *   1. Look the account up by Apple's stable `sub`, never by email — the
 *      email Apple gives can be a private-relay address the person can turn
 *      off, and Apple only sends their name and email on the FIRST sign-in.
 *   2. No account for that sub: mirror the Google rule exactly (see the "NO
 *      SILENT MERGE" comment in googleCallback). An existing password account
 *      with the same address is told to use its password; a Google account
 *      is told to use Google. Otherwise create the account with the
 *      '$apple-only$' marker so the password door can never open it.
 *   3. A session exactly as signin makes one, returned BOTH as the cookie
 *      and in the JSON — the native app keeps the token in the Keychain and
 *      sends it as a Cookie header itself.
 */
async function appleSignIn(request, env, store) {
  const body = await readJson(request);
  const identityToken = String(body.identityToken || '');
  if (!identityToken) return fail(400, 'APPLE_TOKEN_REQUIRED', 'Sign in with Apple did not finish — try again.');

  let apple;
  try {
    apple = await verifyAppleIdentityToken(identityToken, { audience: env.APPLE_BUNDLE_ID || APP_BUNDLE_ID });
  } catch (err) {
    if (err instanceof AppleVerificationError) {
      console.warn('apple sign-in refused', err.code);
      if (err.code === 'APPLE_KEYS_UNREACHABLE') {
        return fail(502, err.code, 'Could not reach Apple to check the sign-in. Try again in a moment.');
      }
      return fail(401, 'APPLE_TOKEN', 'That Apple sign-in could not be verified — try again.');
    }
    throw err;
  }

  let account = await store.accountByAppleSub(apple.sub);
  let status = 200;
  if (!account) {
    let email = null;
    try { if (apple.email && apple.emailVerified) email = normaliseEmail(apple.email); } catch { email = null; }
    if (!email) {
      return fail(401, 'APPLE_EMAIL', 'Apple did not share an email address for this account — try again and choose "Share My Email".');
    }
    const existing = await store.accountByEmail(email);
    if (existing) {
      if (existing.password_hash === '$google-only$') {
        return fail(409, 'APPLE_GOOGLE_ACCOUNT', 'That email signed up with Google — sign in with Google.');
      }
      if (existing.password_hash === '$apple-only$') {
        return fail(409, 'APPLE_OTHER_ACCOUNT', 'That email already belongs to a different Apple sign-in.');
      }
      return fail(409, 'APPLE_PASSWORD_ACCOUNT', 'That email already has a password account — sign in with your password.');
    }
    // Apple sends the name once, on the first sign-in, and only if the
    // person allowed it. Keep what arrives; nothing depends on it.
    const given = body.user?.name?.givenName, family = body.user?.name?.familyName;
    const name = [given, family].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()).join(' ').slice(0, 120) || null;
    account = await store.createAccount({
      id: `acct_${randomId(12)}`,
      email,
      name,
      company: null,
      // Not a hash of anything: the password door can never open this account.
      passwordHash: '$apple-only$',
      appleSub: apple.sub,
      at: nowISO(),
    });
    status = 201;
  }
  const { token, record } = await newSession(account.id);
  await store.putSession(record);
  return json({ account: publicAccount(account), session: token }, {
    status,
    headers: { 'set-cookie': sessionCookie(token, { secure: env.SITE_URL !== 'http://localhost:8787' }) },
  });
}

async function signout(request, env, store) {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token) await store.deleteSession(await hashToken(token));
  return json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie() } });
}

/* ---------------------------------------------------------- delete account */

/**
 * DELETE /api/me — a customer deleting their own account from the iOS app
 * (9 Sep 2026; Apple requires in-app deletion for any app with sign-up).
 *
 * Three steps, in an order chosen so a failure halfway leaves something
 * retryable rather than something half-gone:
 *   1. every session — they are signed out everywhere first, whatever happens next
 *   2. every object under `<accountId>/` in R2, page by page
 *   3. the account row; ON DELETE CASCADE in schema.sql takes photos, jobs,
 *      attempts, grades, reports, sessions, ledger entries and checkpoints.
 * If step 2 throws, the row is still there and the person signs in and taps
 * delete again; nothing is orphaned. Rate-limited like sign-in.
 *
 * This is the customer's door. The owner's erase tool
 * (/internal/board/erase-account) is different on purpose: it anonymises the
 * row and keeps the ledger for the books. Here the whole account goes, as
 * the privacy policy describes.
 */
async function deleteAccount(request, env, account, store) {
  await store.deleteSessionsForAccount(account.id);
  const objects = await deleteAccountObjects(env, account.id);
  await store.deleteAccount(account.id);
  console.warn('account deleted by its owner', account.id, `${objects} objects removed`);
  return json({ ok: true }, { headers: { 'set-cookie': clearedSessionCookie() } });
}

/** Delete everything under `<accountId>/`. R2 deletes up to 1000 keys per call. */
async function deleteAccountObjects(env, accountId) {
  let deleted = 0;
  // List from the start each time rather than paging with a cursor: every
  // page is deleted before the next listing, so the next page is always the
  // first one. The cap only guards against a listing that never shrinks.
  for (let pages = 0; pages < 1000; pages++) {
    const page = await env.PHOTOS.list({ prefix: `${accountId}/`, limit: 1000 });
    const keys = (page.objects || []).map(o => o.key);
    if (!keys.length) break;
    await env.PHOTOS.delete(keys);
    deleted += keys.length;
    if (!page.truncated) break;
  }
  return deleted;
}

/* -------------------------------------------------------------------- credits */

async function credits(account, store) {
  const ledger = await store.ledgerFor(account.id);
  return json({
    balance: ledger.balance,
    statement: ledger.statement().slice(0, 100),
    costs: TRANSFORMATION_COST,
    attemptsPerCredit: ATTEMPTS_PER_CREDIT,
  });
}

/* ---------------------------------------------------------------- promo codes */

/**
 * Redeem a promo code, once per code per account, at most max_uses in total.
 *
 * Order matters: the per-account check runs BEFORE a use is claimed, so someone
 * retyping a code they already used does not burn one of its remaining uses.
 * The claim itself is an atomic UPDATE (the last use cannot be won twice), and
 * the ledger's UNIQUE key is the final referee behind both.
 */
async function redeemPromo(request, account, store) {
  const body = await readJson(request);
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return fail(400, 'NO_CODE', 'Type the code first.');

  const row = await store.promoCodeByCode(code);
  if (!row) return fail(404, 'PROMO_UNKNOWN', "That code isn't one of ours — check the spelling.");

  const key = `promo:${code}:${account.id}`;
  if (await store.ledgerKeyExists(key)) {
    return fail(409, 'ALREADY_REDEEMED', "You've already used that code — it's one per customer.");
  }
  if (row.expires_at && row.expires_at <= nowISO()) {
    return fail(410, 'PROMO_EXPIRED', 'That code has expired.');
  }
  const claimed = await store.claimPromoUse(code, nowISO());
  if (!claimed) return fail(410, 'PROMO_USED_UP', 'That code has already been fully used.');

  const ledger = await store.ledgerFor(account.id);
  const { entry, applied } = ledger.promo({ key, credits: row.credits, code, at: nowISO() });
  if (applied) await store.appendEntry(account.id, entry);
  const balance = await store.balanceFor(account.id);
  return json({ ok: true, credits: row.credits, balance });
}

/* -------------------------------------------------------------------- reports */

/**
 * A customer flagging a problem with one of THEIR jobs. One report per job —
 * a second submission is thanked, not duplicated. The owner reads these at
 * /internal/board/reports beside the job's own audit trail.
 */
async function fileReport(request, account, store) {
  const body = await readJson(request);
  const message = String(body.message || '').trim().slice(0, 2000);
  if (!message) return fail(400, 'NO_MESSAGE', 'Tell us what looks wrong first.');
  const job = await store.jobById(String(body.jobId || ''));
  if (!job || job.account_id !== account.id) return fail(404, 'NOT_FOUND', 'No such photo of yours.');
  const { created } = await store.createReport({
    id: `rep_${randomId(10)}`, jobId: job.id, accountId: account.id, message, at: nowISO(),
  });
  return json({ ok: true, alreadyReported: !created });
}

/**
 * The in-app support box. The message lands in Kyle's inbox through the
 * domain's Email Routing (SUPPORT_EMAIL send binding) with the sender's
 * account attached — so "contact us" works on every phone, mail app or not.
 * Signed-out senders supply an email to reply to; signed-in ones don't have to.
 * cloudflare:email is imported lazily so the module still loads under node
 * for the test suite.
 */
async function supportMessage(request, env, account) {
  const body = await readJson(request);
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!message) return fail(400, 'NO_MESSAGE', 'Write a message first.');
  const replyTo = account?.email || String(body.email || '').trim().slice(0, 200);
  if (!replyTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
    return fail(400, 'NO_EMAIL', 'Add an email address so we can reply to you.');
  }
  if (!env.SUPPORT_EMAIL) {
    return fail(503, 'SUPPORT_DOWN', 'Support is briefly unavailable — email support@thelistinglab.app directly.');
  }
  const meta = [
    `From: ${replyTo}`,
    account ? `Account: ${account.id} (${account.email})` : 'Account: not signed in',
    `At: ${nowISO()}`,
  ].join('\n');
  const raw = [
    'From: Listing Lab Support <support@thelistinglab.app>',
    'To: ksremedia@gmail.com',
    `Reply-To: ${replyTo}`,
    `Subject: Support message from ${replyTo}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <sup-${randomId(12)}@thelistinglab.app>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    message,
    '',
    '--',
    meta,
  ].join('\r\n');
  try {
    const { EmailMessage } = await import('cloudflare:email');
    await env.SUPPORT_EMAIL.send(new EmailMessage('support@thelistinglab.app', 'ksremedia@gmail.com', raw));
  } catch (e) {
    console.error('support email failed', e.message);
    return fail(502, 'SEND_FAILED', 'Could not send just now — email support@thelistinglab.app directly.');
  }
  return json({ sent: true });
}

/* ------------------------------------------------------------------- checkout */

/**
 * Start a Stripe Checkout session.
 *
 * HOSTED CHECKOUT ON PURPOSE. Apple Pay and Google Pay need no configuration
 * here and no domain registration, because the payment sheet is on Stripe's
 * domain, not ours. Embedding the payment form in our own page would mean
 * registering every domain and subdomain with Apple first. For an audience of
 * estate agents on phones, the wallet button appearing by itself is worth the
 * redirect.
 *
 * The browser sends a PACK ID, never a price. The price comes from our own list,
 * and the webhook checks the amount actually paid against it again before
 * granting anything.
 */
async function startCheckout(request, env, account, store) {
  // The owner's first lever: close the store without breaking anything for
  // paying customers. The dashboard promises this exact sentence.
  if (await store.getFlag('salesPaused')) {
    return fail(503, 'SALES_PAUSED', 'Credit sales are temporarily paused — existing credits work normally.');
  }
  const body = await readJson(request);
  const pack = CREDIT_PACKS.find(p => p.id === body.packId);
  if (!pack) return fail(400, 'UNKNOWN_PACK', 'Choose one of the credit packs.');

  /**
   * THE iPHONE APP PAYS HERE TOO (decided 10 Sep 2026). Credits are not sold
   * through Apple: the app opens this same hosted Checkout in Safari and
   * Stripe sends the person back to /purchase/return, a small page that
   * hands off to the app (listinglab://purchase?status=…). The webhook grants
   * the credits exactly as for the web — nothing else here knows or cares
   * which client started the purchase. `platform` is the only difference.
   */
  const ios = body.platform === 'ios';
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', ios ? `${env.SITE_URL}/purchase/return?status=success` : `${env.SITE_URL}/app?purchase=success`);
  form.set('cancel_url', ios ? `${env.SITE_URL}/purchase/return?status=cancelled` : `${env.SITE_URL}/app?purchase=cancelled`);
  form.set('client_reference_id', account.id);
  form.set('customer_email', account.email);
  // What the webhook reads back. account_id is how we know whose balance to raise.
  form.set('metadata[pack_id]', pack.id);
  form.set('metadata[account_id]', account.id);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][unit_amount]', String(pack.priceCents));
  form.set('line_items[0][price_data][product_data][name]', `${pack.credits} Listing Lab credits`);
  // Wallets are automatic with hosted Checkout — Apple Pay and Google Pay show up
  // on their own when the customer's device supports them. Nothing to enable here.
  form.set('payment_method_types[0]', 'card');

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      // If this request is retried, Stripe reuses the same session rather than
      // opening a second one.
      'idempotency-key': `checkout:${account.id}:${pack.id}:${Math.floor(Date.now() / 60000)}`,
    },
    body: form,
  });

  if (!res.ok) {
    console.error('stripe checkout failed', res.status, await res.text());
    return fail(502, 'CHECKOUT_FAILED', 'Could not start checkout. Try again in a moment.');
  }
  const session = await res.json();
  return json({ url: session.url, sessionId: session.id });
}

/* -------------------------------------------------------------------- webhook */

/**
 * Stripe's webhook endpoint.
 *
 * Order matters and is the whole design:
 *   1. verify the signature on the RAW body
 *   2. write the receipt
 *   3. return 200 immediately
 *   4. grant the credits after the response, via waitUntil
 *
 * Stripe times out slow endpoints and then retries them, which manufactures the
 * duplicate deliveries we work so hard to absorb. So nothing slow happens before
 * the 200.
 */
async function stripeWebhook(request, env, ctx, store) {
  // Read the body as text. Parsing and re-stringifying changes the bytes and the
  // signature will never match.
  const raw = await request.text();
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREVIOUS].filter(Boolean);

  let event;
  try {
    event = await verifyStripeWebhook(raw, request.headers.get('stripe-signature'), secrets);
  } catch (err) {
    if (err instanceof StripeVerificationError) {
      console.warn('rejected webhook', err.code);
      // 400 tells Stripe not to keep retrying something we will never accept.
      return fail(400, err.code, 'Rejected.');
    }
    throw err;
  }

  if (event.type !== CREDIT_GRANTING_EVENT) {
    // Subscribed to something we do not act on. Acknowledge so Stripe stops.
    return json({ received: true, ignored: event.type });
  }

  const fresh = await store.recordStripeEvent({
    eventId: event.id,
    eventType: event.type,
    objectId: event.data?.object?.id ?? 'unknown',
    payload: raw,
    at: nowISO(),
  });

  // Already seen this exact event id — a retry. Nothing more to do.
  if (!fresh) return json({ received: true, duplicate: true });

  ctx.waitUntil(grantCredits(event, store));
  return json({ received: true });
}

/**
 * Grant the credits for a completed checkout. Runs after the 200 has gone back.
 *
 * Two independent guards stand between this and a double grant: the ledger key
 * is derived from the checkout SESSION, so a second Event object about the same
 * purchase collapses onto it; and the database has that key as a PRIMARY KEY, so
 * even two simultaneous writers cannot both win.
 */
async function grantCredits(event, store) {
  try {
    const grant = creditGrantFromEvent(event);
    if (!grant) {
      await store.markStripeEventProcessed(event.id, nowISO(), 'nothing to grant');
      return;
    }
    const key = creditKeyFor({ objectId: grant.objectId, eventType: grant.eventType });
    const ledger = await store.ledgerFor(grant.accountId);
    const { entry, applied } = ledger.purchase({
      key, credits: grant.credits, packId: grant.packId, stripeEventId: grant.eventId, at: nowISO(),
    });
    if (applied) {
      await store.appendEntry(grant.accountId, { ...entry, stripeObjectId: grant.objectId });
    }
    await store.markStripeEventProcessed(event.id, nowISO());
  } catch (err) {
    // Record and move on. The receipt in stripe_events means a failed grant can
    // be replayed by hand without asking Stripe to resend anything.
    console.error('grant failed', event.id, err?.stack || err);
    await store.markStripeEventProcessed(event.id, nowISO(), String(err?.message || err).slice(0, 500));
  }
}

/* ------------------------------------------------------------------- transform */

/**
 * Start a transformation.
 *
 * Charge first, then queue. If the charge fails there is nothing to undo; if the
 * queue fails the job is charged but never runs, and the attempt accounting will
 * eventually mark it refundable — which is the right way round. The opposite
 * order gives away free work whenever a charge fails after the pipeline started.
 */
async function startTransform(request, env, ctx, account, store) {
  // The owner's emergency brake: no new jobs, zero API spend, credits safe.
  // The dashboard promises this exact sentence.
  if (await store.getFlag('genPaused')) {
    return fail(503, 'GENERATION_PAUSED', 'AI generation is temporarily paused. Your credits are safe and never expire.');
  }
  const body = await readJson(request);
  const { photoId, transformation } = body;
  if (!photoId) return fail(400, 'PHOTO_REQUIRED', 'Choose a photo.');
  if (!TRANSFORMATION_COST[transformation]) {
    return fail(400, 'UNKNOWN_TRANSFORMATION', 'That is not one of the four transformations.');
  }

  // Check the photo belongs to this account BEFORE charging. Same 404 for
  // someone else's photo as for one that does not exist.
  const photo = await store.photoById(photoId);
  if (!photo || photo.account_id !== account.id) return fail(404, 'NOT_FOUND', 'No such photo.');

  // Enforce the scene rule here as well as in the UI. The browser is not a
  // security boundary, and this is the check that keeps a false disclosure off a
  // photograph even if someone calls the API directly.
  let signals = null;
  try { signals = photo.scene ? JSON.parse(photo.scene) : null; } catch {}
  const allowed = offeredFor(signals);
  if (!allowed.includes(transformation)) {
    return fail(422, 'NOT_APPLICABLE',
      transformation === 'staging'
        ? 'This room is already furnished. Empty it first, then stage it.'
        : signals?.isExterior
          ? 'That only applies to interior photos. Try Twilight for an exterior.'
          : 'That transformation does not apply to this photo.');
  }

  // Before the charge, not after it. An option the pipeline will refuse is a 400
  // now, rather than a spent credit and a container that dies on startup.
  if (transformation === 'staging') {
    if (!STAGING_STYLES.includes(body.style)) {
      return fail(400, 'UNKNOWN_STYLE', `Choose a style: ${STAGING_STYLES.join(', ')}.`);
    }
    if (!ROOM_TYPES.includes(body.roomType)) {
      return fail(400, 'UNKNOWN_ROOM', `Choose a room type: ${ROOM_TYPES.join(', ')}.`);
    }
  }
  if (transformation === 'twilight' && body.style && !TWILIGHT_MOODS.includes(body.style)) {
    return fail(400, 'UNKNOWN_STYLE', `Choose a look: ${TWILIGHT_MOODS.join(', ')}.`);
  }

  const jobId = `job_${randomId(12)}`;
  const ledger = await store.ledgerFor(account.id);
  // Fast pre-check on the snapshot balance: throws INSUFFICIENT_CREDITS (→ 402)
  // in the common case with a friendly message, before we create anything. It
  // is NOT the referee — a stale snapshot could still pass here under a race —
  // so the real guard is the atomic DB debit below.
  const { entry } = ledger.debitForJob({ key: `${jobId}:debit`, jobId, transformation, at: nowISO() });
  const cost = -entry.delta;

  // Twilight has one look and the app does not ask — but the pipeline still
  // requires a valid mood, so default it here rather than trusting the browser
  // to send one. Dusk is the look Kyle grades as a pass.
  const style = transformation === 'twilight' ? (body.style || 'Dusk') : (body.style ?? null);

  // The job row must exist before the ledger entry (ledger_entries.job_id is a
  // foreign key). So create it, then charge atomically; if the atomic charge
  // loses the race for the last credits, delete the orphan job we just made so
  // no unpaid job is ever left for the reaper to run for free (also closes the
  // pipeline review's orphan-job finding).
  const job = await store.createJob({
    id: jobId, accountId: account.id, photoId, transformation,
    style, roomType: body.roomType ?? null,
    options: body.options ?? null, attemptsAllowed: ATTEMPTS_PER_CREDIT, at: nowISO(),
  });
  const charge = await store.debitForJobIfAffordable(
    account.id, { ...entry, jobId, transformation }, cost);
  if (!charge.applied && charge.insufficient) {
    await store.deleteJob(jobId).catch(() => {});
    return fail(402, 'INSUFFICIENT_CREDITS', 'Not enough credits for that one.');
  }

  ctx.waitUntil(dispatchToPipeline(env, job, photo, store));

  return json({
    jobId,
    status: 'queued',
    balance: (await store.ledgerFor(account.id)).balance,
  }, { status: 202 });
}

/* --------------------------------------------------------------- photographs */

/**
 * Which transformations to offer for a given photograph.
 *
 * THE RULE THIS ENCODES
 * Refusing work an agent actually wants is worse than allowing work that turns
 * out to be pointless. A pointless job costs one credit which comes straight back
 * when nothing changes; a wrong refusal means they cannot do the job at all and
 * conclude the product is broken.
 *
 * So this only rules OUT the genuinely absurd — staging a room that is already
 * furnished, decluttering the outside of a house — and offers everything else.
 *
 * The first version got this backwards. It sorted a photo into one bucket, and
 * "empty room" was worded as "no furniture, or only a token piece or two" — which
 * swallowed the exact case Kyle raised: a room with two boxes in it, where those
 * two boxes ARE the job. One label cannot say both "there is something to remove"
 * and "there is floor to furnish"; a room with two boxes is both.
 *
 * `signals` is what the classifier saw. Anything missing means it could not tell,
 * and everything is offered.
 */
export function offeredFor(signals) {
  const all = ['declutter', 'empty', 'staging', 'twilight'];
  if (!signals || typeof signals !== 'object') return all;

  // An exterior is only ever a twilight. Nothing else applies to a lawn.
  if (signals.isExterior) return ['twilight'];

  // A signals object with nothing usable in it is the same as no answer at all —
  // the classifier could not tell, so do not let it narrow anything.
  if (!signals.removableClutter && !signals.furniture) return all;

  const offers = [];

  // Offer removal unless the room is genuinely, verifiably bare. "some" — two
  // boxes, a few things on a bathroom counter — is a job, not a no-op.
  const clutter = signals.removableClutter;
  const furniture = signals.furniture;
  if (clutter !== 'none' || furniture !== 'none') {
    offers.push('declutter');
    // Emptying a room only means something if there is furniture to remove.
    if (furniture !== 'none') offers.push('empty');
  }

  // Staging needs floor to put furniture on, and a room not already full of it.
  if (signals.stageableFloor !== false && furniture !== 'furnished') offers.push('staging');

  // Never hand back nothing. If the signals somehow rule everything out, the
  // classifier is more likely wrong than the photograph is useless.
  return offers.length ? offers : all;
}

/**
 * A gentle heads-up, not a locked door — shown next to an offer that may not
 * achieve much, so the agent decides rather than the app deciding for them.
 */
export function adviceFor(signals, transformation) {
  if (!signals) return null;
  if ((transformation === 'declutter') && signals.removableClutter === 'some') {
    return 'There is not much here to remove — expect a small change.';
  }
  // Kyle's routing insight, 28 Aug 2026: rooms with clutter piled high are
  // exactly where declutter struggles and Empty Room shines — an agent facing
  // one doesn't want it tidied, they want it blank. Steer, never block.
  if ((transformation === 'declutter') && signals.removableClutter === 'lots') {
    return 'A very full room — Empty Room clears everything in one pass and succeeds more often on rooms like this.';
  }
  if (transformation === 'staging' && signals.furniture === 'sparse') {
    return 'This room still has a piece or two in it. Emptying it first usually stages better.';
  }
  return null;
}

/** Only what the pipeline can actually open. */
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

/**
 * What the bytes actually are: 'jpeg', 'png', 'heic', or null for anything
 * else. HEIC is ISO-BMFF — 'ftyp' at offset 4, then a brand code — which is
 * how a renamed .heic betrays itself no matter what the header claimed.
 */
function sniffImageFormat(buf) {
  const b = new Uint8Array(buf.slice(0, 16));
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) { // 'ftyp'
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1|avif)$/.test(brand)) return 'heic';
  }
  return null;
}
/** A 4K phone photo is a few MB; 25 is generous and still bounds the damage. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Take a photo from the agent's phone.
 *
 * The key is namespaced by account, so one agent's key can never address
 * another's object even if a key leaks into a URL somewhere.
 */
async function uploadPhoto(request, env, ctx, account, store) {
  const contentType = request.headers.get('content-type') || '';
  let bytes, type, listingId, filename;

  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('photo');
    if (!file || typeof file === 'string') return fail(400, 'NO_PHOTO', 'Attach a photo.');
    bytes = await file.arrayBuffer();
    type = file.type || 'image/jpeg';
    filename = file.name || 'photo.jpg';
    listingId = form.get('listingId') || null;
  } else {
    bytes = await request.arrayBuffer();
    type = contentType.split(';')[0] || 'image/jpeg';
    filename = 'photo.jpg';
    listingId = new URL(request.url).searchParams.get('listingId');
  }

  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    return fail(415, 'UNSUPPORTED_TYPE', 'Upload a JPEG or PNG.');
  }
  if (bytes.byteLength === 0) return fail(400, 'EMPTY_PHOTO', 'That file is empty.');
  // Trust the BYTES, not the label. First customer failure (31 Aug 2026,
  // job_882fb75b…): an iPhone HEIC renamed .jpg carried content-type
  // image/jpeg straight past the type check, and the pipeline container —
  // which has no HEIC decoder — died on it six minutes later. The customer
  // got a generic apology for what was a knowable-at-upload problem. So the
  // gate now reads the magic bytes and answers at once, in plain language.
  const sniffed = sniffImageFormat(bytes);
  if (sniffed === 'heic') {
    return fail(415, 'HEIC_DISGUISED',
      "That's an iPhone HEIC photo even though it's named like a JPEG. Reload this page — iPhone photos now convert automatically — and upload it again.");
  }
  if (sniffed === null) {
    return fail(415, 'NOT_AN_IMAGE', "That file doesn't look like a photo we can open. JPEG or PNG works best.");
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return fail(413, 'PHOTO_TOO_LARGE', 'That photo is over 25MB.');
  }

  // No listing given? Put it in a catch-all for this account so an agent can just
  // upload a photo without first inventing a listing.
  if (!listingId) listingId = await ensureInbox(account, store);

  const photoId = `pho_${randomId(12)}`;
  const key = `${account.id}/${photoId}/original`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: type } });
  await store.createPhoto({ id: photoId, listingId, accountId: account.id, originalKey: key, at: nowISO() });

  // Answer the moment the bytes are stored; read the room in the BACKGROUND
  // (1 Sep 2026 — this classify call used to sit between the upload and the
  // response, so the progress bar hung at 100% for a vision call and
  // sometimes a container cold-boot on top). The app polls /scene and fills
  // in the right buttons a moment later; scene-gating is enforced again at
  // job submission either way, so nothing rides on the race.
  ctx.waitUntil((async () => {
    try {
      const signals = await classifyPhoto(env, key);
      if (signals) await store.setPhotoScene(photoId, JSON.stringify(signals));
    } catch (err) {
      console.error('classify failed', err?.message || err);
    }
  })());

  const offers = offeredFor(null);
  return json({
    photoId, listingId, filename,
    signals: null,
    classifying: true,
    offers,
    advice: {},
    url: `/api/photos/${encodeURIComponent(key)}`,
  }, { status: 201 });
}

/**
 * Adopt a delivered result as a new starting photo — the server side of
 * "Stage this room" (1 Sep 2026).
 *
 * The app used to download the delivered JPEG and re-upload it, which fed the
 * next transformation an image with our disclosure stamp baked into the
 * corner; the model sometimes redrew that stamp under the fresh one and a
 * garbled double watermark reached a delivery on 31 Aug. Here the copy happens
 * server-side from the clean (pre-watermark) frame stored beside the result,
 * so the chained edit starts from an unstamped photograph and the clean bytes
 * never leave the building. Deliveries from before the clean copies existed
 * fall back to the stamped result — same behaviour as the old flow, no worse.
 */
async function photoFromJob(request, env, ctx, account, store) {
  const body = await readJson(request);
  const job = body.jobId ? await store.jobById(String(body.jobId)) : null;
  // Same 404 for someone else's job as for one that does not exist.
  if (!job || job.account_id !== account.id) return fail(404, 'NOT_FOUND', 'No such job.');
  if (job.status !== 'delivered' || !job.result_key) {
    return fail(422, 'NOT_DELIVERED', 'Only a delivered result can be used as a new starting photo.');
  }
  const cleanKey = job.result_key.replace(/-result\.jpg$/, '-result-clean.jpg');
  const object = (cleanKey !== job.result_key && await env.PHOTOS.get(cleanKey)) || await env.PHOTOS.get(job.result_key);
  if (!object) return fail(404, 'NOT_FOUND', 'No such photo.');
  const bytes = await object.arrayBuffer();

  // Land it beside its parent: same listing as the photo the job ran on.
  const parent = await store.photoById(job.photo_id);
  const listingId = parent?.listing_id || await ensureInbox(account, store);

  const photoId = `pho_${randomId(12)}`;
  const key = `${account.id}/${photoId}/original`;
  await env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await store.createPhoto({ id: photoId, listingId, accountId: account.id, originalKey: key, at: nowISO() });

  // Same answer-now-classify-later shape as uploadPhoto, same reason.
  ctx.waitUntil((async () => {
    try {
      const signals = await classifyPhoto(env, key);
      if (signals) await store.setPhotoScene(photoId, JSON.stringify(signals));
    } catch (err) {
      console.error('classify failed', err?.message || err);
    }
  })());

  return json({
    photoId, listingId, filename: 'photo.jpg',
    signals: null,
    classifying: true,
    offers: offeredFor(null),
    advice: {},
    url: `/api/photos/${encodeURIComponent(key)}`,
  }, { status: 201 });
}

async function classifyPhoto(env, objectKey) {
  // Its own slot, so a two-second classification never queues behind a
  // seven-minute staging render.
  const container = env.PIPELINE.get(env.PIPELINE.idFromName('classify'));
  const res = await container.fetch('https://pipeline.internal/classify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      imageUrl: `${env.SITE_URL}/internal/photos/${encodeURIComponent(objectKey)}?s=${env.PIPELINE_SECRET}`,
    }),
  });
  if (!res.ok) {
    console.error('classify HTTP', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const out = await res.json();
  // The container answers 200 with an error rather than failing an upload.
  // Surface it here or it is invisible.
  if (out.error) { console.error('classify error from container:', String(out.error).slice(0, 400)); return null; }
  return out;
}

async function ensureInbox(account, store) {
  const existing = await store.inboxListing(account.id);
  if (existing) return existing.id;
  const id = `lst_${randomId(12)}`;
  await store.createListing({ id, accountId: account.id, address: 'Uploads', at: nowISO() });
  return id;
}

/**
 * Serve a photo.
 * The key starts with the owning account id, so the check is a prefix test — and
 * a miss returns 404 rather than 403, so keys cannot be probed.
 */
/**
 * `?download=1` asks for it as a file rather than a picture to look at.
 *
 * WHY THE FLAG EXISTS
 * Kyle, 26 Aug 2026: "download link once photo is done doesn't work". The button
 * was an `<a download>` pointing at this route, which served the bytes as
 * `image/jpeg` and nothing else. Safari on iOS treats the `download` attribute as
 * a suggestion and opens the image in the tab instead — the agent taps Download
 * and gets a picture on screen, no file. A `content-disposition: attachment`
 * header is not a suggestion, so the browser saves it whatever it thinks of the
 * attribute.
 *
 * Same bytes either way; only the header differs, so the preview in the
 * before/after slider still loads inline.
 */
function attachmentName(key) {
  const base = key.split('/').pop() || 'photo.jpg';
  // Header-safe, and recognisable in a Downloads folder six weeks later.
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '-').slice(-80);
  return `listing-lab-${clean.endsWith('.jpg') ? clean : clean + '.jpg'}`;
}

/** Previews are this wide: a grid tile is 150–320 points, so 640 px covers a 2× screen. */
const PREVIEW_WIDTH = 640;
/** Cloudflare's image tool takes at most 20 MB in; a bigger photo is served whole. */
const PREVIEW_INPUT_LIMIT = 20 * 1024 * 1024;

async function servePhoto(key, env, account, asDownload = false, asPreview = false) {
  if (!key.startsWith(`${account.id}/`)) return fail(404, 'NOT_FOUND', 'No such photo.');
  // The clean (pre-watermark) copies exist only to feed chained edits. They are
  // never served: every image a customer can reach carries its disclosure stamp.
  if (key.includes('-result-clean.jpg')) return fail(404, 'NOT_FOUND', 'No such photo.');
  if (asPreview && !asDownload && !key.endsWith('-preview.jpg')) {
    const preview = await servePreview(key, env);
    if (preview) return preview;
  }
  const object = await env.PHOTOS.get(key);
  if (!object) return fail(404, 'NOT_FOUND', 'No such photo.');
  const headers = {
    'content-type': object.httpMetadata?.contentType || 'image/jpeg',
    // Immutable: a key is never rewritten, so a result can be cached hard.
    'cache-control': 'private, max-age=31536000, immutable',
  };
  if (asDownload) headers['content-disposition'] = `attachment; filename="${attachmentName(key)}"`;
  return new Response(object.body, { headers });
}

/**
 * A small copy of a photo for the app's My photos grid (Kyle's phone, 10 Sep
 * 2026: the grid pulled sixty full-size photos, several megabytes each, to
 * fill tiles a few hundred pixels wide, and sat empty while it waited).
 *
 * Made once, by Cloudflare's image tool, the first time anyone asks — old
 * photos included, no migration — and kept in R2 beside the photo as
 * `<key>-preview.jpg`, so every later request is a plain read. The width is
 * the only parameter, which keeps it to one billable shrink per photo, ever.
 *
 * Anything that stops a preview being made — no binding, a photo over the
 * tool's input limit, a transform error — answers null and the caller serves
 * the full photo, so a preview problem can never hide a photo. The preview
 * carries the same disclosure stamp as the photo it was shrunk from.
 */
async function servePreview(key, env) {
  const previewKey = `${key}-preview.jpg`;
  const headers = {
    'content-type': 'image/jpeg',
    'cache-control': 'private, max-age=31536000, immutable',
  };
  const stored = await env.PHOTOS.get(previewKey);
  if (stored) return new Response(stored.body, { headers });
  if (!env.IMAGES) return null;
  const object = await env.PHOTOS.get(key);
  if (!object || object.size > PREVIEW_INPUT_LIMIT) return null;
  try {
    const made = await env.IMAGES.input(object.body)
      .transform({ width: PREVIEW_WIDTH })
      .output({ format: 'image/jpeg', quality: 82 });
    const bytes = await made.response().arrayBuffer();
    if (!bytes.byteLength) return null;
    await env.PHOTOS.put(previewKey, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
    return new Response(bytes, { headers });
  } catch (err) {
    console.error('preview failed', key, err?.message || err);
    return null;
  }
}

/* ------------------------------------------------------------------ pipeline */

/**
 * How many container instances the job pool may use.
 *
 * WHY A POOL AND NOT ONE PER JOB
 * The first deployed version addressed the container as
 * `PIPELINE.idFromName(job.id)` — a brand new Durable Object, and therefore a
 * brand new container instance, for every single job. With `max_instances = 3`
 * and instances lingering after their work, the fourth job onwards got:
 *
 *   Container error: Maximum number of running container instances exceeded.
 *
 * and sat in "queued" forever with no error the customer could see. Jobs are not
 * long-lived identities that need their own machine; they are work to be handed
 * to a worker. So they go to a fixed, small pool instead, and the container —
 * which is an ordinary HTTP server — handles what it is given.
 *
 * Classification gets its own slot so a fast, cheap call at upload time never
 * waits behind a seven-minute staging render.
 */
// 8, up from 4 (1 Sep 2026): Kyle's first real batch — twelve photos at once
// — queued four wide, and half the deliveries spent longer waiting for a slot
// than being worked on (audit: 11-minute deliveries carrying 3-minute runs).
// Instances bill only while running, and max_instances leaves headroom at 50.
//
// 15, up from 8 (2 Sep 2026, Kyle: "should be at fifteen at minimum... why
// not have it if we can"): the 20-job validation batch overflowed 8 slots and
// the stall-reclaims from pure queue contention read as phantom "outages" on
// the board. At 15 slots × 2 jobs each, a 30-photo drop runs without our own
// pool being the bottleneck. The honest limit that remains is the VENDOR's:
// fal serves ~10 images at once regardless of our slot count — beyond that,
// generations wait in fal's queue (the queue fallback holds the ticket), so
// more slots buy parallel judging/compositing, not infinite generation.
const JOB_POOL_SIZE = 15;

/**
 * Stable, evenly-spread slot for a job id — but a RETRY HOPS to a different
 * slot (2 Sep 2026, the four-poisoned-slots incident). The midday battery
 * failed 8 of 20 jobs and the autopsy showed every failure sat on one of four
 * sick container instances (slots 5, 6, 8, 9) while every job on any other
 * slot delivered. Slot-sticky retries meant a job that drew a poisoned slot
 * retried on the SAME poisoned slot until the 15-minute give-up — a
 * deterministic death sentence dressed up as bad luck. The `spread` argument
 * (the job's outage_retries) offsets the hash so each retry lands on a fresh
 * instance: a sick slot now costs one parked attempt, never the job.
 */
function poolSlot(jobId, spread = 0) {
  let h = 0;
  for (let i = 0; i < jobId.length; i++) h = (h * 31 + jobId.charCodeAt(i)) >>> 0;
  return `pipeline-${(h + (spread || 0)) % JOB_POOL_SIZE}`;
}

/**
 * Hand the job to the container.
 *
 * The pipeline needs `sharp` for every crop and watermark, which is a compiled
 * binary and cannot run in a Worker. It lives in a Container instead, running the
 * proven Node code unchanged.
 *
 * Fire and forget: the container answers 202 straight away and reports back to
 * /internal/jobs/:id/result minutes later. Nothing holds a socket open for the
 * length of a staging job.
 */
/**
 * THE HEALTH PROBE + SLOT BREAKER (2 Sep 2026, the poisoned-slots incident).
 * Before a job is handed over, the slot answers a quick /health knock. A slot
 * that cannot answer within the budget is skipped ON THE SPOT — the job tries
 * the next slot immediately instead of parking for minutes — and the failure
 * is recorded in slot_health. A slot with consecutive probe failures is
 * QUARANTINED (skipped without even knocking) for a cooldown, so a sick
 * datacenter or a wedged instance costs seconds, never jobs. The probe budget
 * is generous because a healthy COLD instance needs boot time; only true
 * silence fails it.
 */
const PROBE_TIMEOUT_MS = parseInt(globalThis.PROBE_TIMEOUT_MS || '12000', 10);
const HANDOFF_TIMEOUT_MS = 20_000;       // /run must answer 202 in this long
const SLOT_QUARANTINE_AFTER = 2;          // consecutive probe failures
const SLOT_QUARANTINE_MINUTES = 10;

async function probeSlot(env, slotName) {
  const container = env.PIPELINE.get(env.PIPELINE.idFromName(slotName));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await container.fetch('https://pipeline.internal/health', { signal: ac.signal });
    if (!r.ok) return { ok: false, why: `health ${r.status}` };
    const body = await r.json().catch(() => ({}));
    if (body.draining) return { ok: false, why: 'draining' };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

/** Pick a healthy slot for this job: quarantine-aware, probe-verified. */
async function pickHealthySlot(env, store, jobId, spread) {
  const quarantined = await store.quarantinedSlots(SLOT_QUARANTINE_MINUTES).catch(() => new Set());
  for (let hop = 0; hop < 4; hop++) {
    const slotName = poolSlot(jobId, (spread || 0) + hop);
    if (quarantined.has(slotName) && hop < 3) continue;   // skip without knocking
    const probe = await probeSlot(env, slotName);
    await store.recordSlotProbe(slotName, probe.ok, probe.why || null, SLOT_QUARANTINE_AFTER).catch(() => {});
    if (probe.ok) return slotName;
  }
  // Everything looked sick — dispatch to the base slot anyway; parking is the backstop.
  return poolSlot(jobId, spread || 0);
}

async function dispatchToPipeline(env, job, photo, store) {
  try {
    const slotName = await pickHealthySlot(env, store, job.id, job.outage_retries || 0);
    const container = env.PIPELINE.get(env.PIPELINE.idFromName(slotName));
    /**
     * THE HAND-OFF GETS A CLOCK (9 Sep 2026). A healthy container answers
     * /run in well under a second — it accepts the job and returns 202 before
     * doing any work. Tonight one instance took the connection and never
     * answered: no 202, no error, so nothing below ran — no dispatch stamp,
     * no park — and Kyle's twilight sat in "waiting to start" until the
     * 12-minute silence rule found it. Twenty seconds is an eternity for a
     * 202; past that the hand-off is dead and the job parks for a retry on
     * another slot (parking bumps outage_retries, which is the slot spread).
     */
    const handAc = new AbortController();
    const handTimer = setTimeout(() => handAc.abort(), HANDOFF_TIMEOUT_MS);
    let handed;
    try {
      handed = await container.fetch('https://pipeline.internal/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: handAc.signal,
      body: JSON.stringify({
        jobId: job.id,
        transformation: job.transformation,
        style: job.style,
        roomType: job.room_type,
        // Signed-in fetch is not available to the container, so it reads the
        // original through an internal route guarded by the same shared secret.
        originalUrl: `${env.SITE_URL}/internal/photos/${encodeURIComponent(photo.original_key)}?s=${env.PIPELINE_SECRET}`,
        callbackUrl: `${env.SITE_URL}/internal/jobs/${job.id}/result`,
        callbackSecret: env.PIPELINE_SECRET,
      }),
      });
    } finally { clearTimeout(handTimer); }
    // A container that is already running its share says 503 rather than taking
    // on work it cannot finish well. That is not an error — it is the right
    // answer — so it goes back in the queue instead of being treated as a fault.
    if (handed.status === 503) {
      throw new Error(`container busy: ${(await handed.text()).slice(0, 120)}`);
    }
    // Stamp it, so the reaper measures silence from the last time anyone
    // actually spoke to a container rather than from when the job was created.
    await store.markDispatched(job.id, nowISO()).catch(() => {});
  } catch (err) {
    /**
     * The container would not take the job.
     *
     * This used to fail the job and refund on the spot, which was right when
     * there was nowhere to put it. There is now: a container that is cold,
     * restarting after a deploy, or briefly out of instances is the most
     * transient condition in the system, and telling an agent "we could not
     * start that job" because Cloudflare was two seconds from being ready is a
     * failure invented entirely by us.
     *
     * Seen live on 26 Aug 2026, minutes after a deploy: two jobs refused at
     * dispatch and refunded, while the container image itself was healthy and
     * answering /health locally.
     *
     * So it parks like any other retryable failure, and only gives up once the
     * queue has. Nothing is charged in the meantime.
     */
    console.error('pipeline dispatch failed', job.id, err?.stack || err);
    if ((job.outage_retries || 0) < OUTAGE_RETRY_LIMIT) {
      try {
        await store.parkJobForRetry({ jobId: job.id, retryAfter: new Date(Date.now() + 15_000).toISOString() });
        console.log(`job ${job.id} parked: container would not take it, retrying shortly`);
        return;
      } catch (e2) {
        console.error('could not park a job after a failed dispatch', job.id, e2?.message || e2);
      }
    }
    await failJobAndRefund(store, job,
      'We could not start that job. Your credits have been returned — please try again.', env);
  }
}

/**
 * The container reporting back.
 *
 * This is where a rejected job gives the customer their credits back — the one
 * place in the system that does, so the promise on the marketing page has exactly
 * one implementation.
 */
/** Parse a job row's variant_keys JSON into photo URLs; bad JSON reads as none. */
function variantUrlsFor(job) {
  try {
    const keys = JSON.parse(job.variant_keys || '[]');
    return Array.isArray(keys) ? keys.map(k => `/api/photos/${encodeURIComponent(k)}`) : [];
  } catch { return []; }
}

async function pipelineResult(jobId, request, env, store, ctx = null) {
  if (!env.PIPELINE_SECRET || request.headers.get('x-pipeline-secret') !== env.PIPELINE_SECRET) {
    return fail(401, 'NOT_AUTHORISED', 'Rejected.');
  }
  const body = await readJson(request);
  const job = await store.jobById(jobId);
  if (!job) return fail(404, 'NOT_FOUND', 'No such job.');
  if (job.finished_at) return json({ ok: true, alreadyFinished: true });

  if (body.outcome === 'delivered' && body.image?.base64) {
    const key = `${job.account_id}/${job.photo_id}/${jobId}-result.jpg`;
    await env.PHOTOS.put(key, base64ToBytes(body.image.base64), {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    // The pre-watermark frame, stored ONLY as the source for chained edits
    // ("Stage this room"). servePhoto refuses this key on purpose — no
    // customer route ever serves an undisclosed AI edit. Best-effort: a job
    // from an older container build simply has no clean copy.
    if (body.cleanImage?.base64) {
      try {
        await env.PHOTOS.put(`${job.account_id}/${job.photo_id}/${jobId}-result-clean.jpg`,
          base64ToBytes(body.cleanImage.base64), { httpMetadata: { contentType: 'image/jpeg' } });
      } catch (e) { console.error('clean copy store failed', jobId, e?.message || e); }
    }
    // Runner-up versions that passed the same checks (staging, up to two).
    // Stored best-effort: a failed extra must never cost the customer the
    // winner, so each one is its own try/catch.
    const variantKeys = [];
    for (const [i, img] of (body.extraImages || []).slice(0, 2).entries()) {
      if (!img?.base64) continue;
      try {
        const vKey = `${job.account_id}/${job.photo_id}/${jobId}-result-v${i + 2}.jpg`;
        await env.PHOTOS.put(vKey, base64ToBytes(img.base64), {
          httpMetadata: { contentType: 'image/jpeg' },
        });
        variantKeys.push(vKey);
      } catch (e) { console.error('variant store failed', jobId, e?.message || e); }
    }
    const delivered = await store.finishJob({
      jobId, status: 'delivered', resultKey: key, variantKeys,
      costUsd: body.audit?.spend?.cost, at: nowISO(),
    });
    if (delivered.changed) await notifyJobFinished(env, store, { ...job, status: 'delivered' }, ctx);
    // Keep the record for jobs that SUCCEEDED too, not only the ones that broke.
    // Kyle reported a colour cast on a delivered bathroom on 26 Aug 2026 and there
    // was nothing stored to answer "what did the checks conclude?" — every audit
    // in the database was an error. A delivered job is exactly the one worth being
    // able to reconstruct later, because nobody looks at it until a customer does.
    await store.recordAttempt({
      id: `att_${randomId(10)}`, jobId, attemptNo: body.attemptsUsed || 1,
      outcome: 'delivered', rawKey: key, audit: auditSummary(body.audit), at: nowISO(),
    }).catch(err => console.error('could not record the delivered attempt', jobId, err?.message || err));
  } else if ((body.retryable ?? body.upstreamDown) && (job.outage_retries || 0) < OUTAGE_RETRY_LIMIT
             && (Date.now() - Date.parse(job.created_at)) < GIVE_UP_AFTER_MS) {
    /**
     * Google was busy. That is not a finished job.
     *
     * Park it, keep the credit held, and let the sweep try again. The attempt is
     * still recorded — an outage is exactly the kind of thing worth being able to
     * count later — but nothing about the job's outcome is written, because it
     * does not have one yet.
     */
    // An interruption on our own side is worth retrying sooner than an outage:
    // there is nothing to wait for, the last run simply did not happen.
    //
    // The jitter matters. With a fixed spacing every job parked in the same
    // outage minute comes due in the same sweep, gets redispatched together, and
    // — when the outage is actually a per-minute rate limit — re-trips it
    // together, forever. Seen in beta 31 Aug 2026: two parallel declutters
    // starving each other in lockstep. Up to 45 extra seconds spreads the herd
    // across sweeps.
    const jitter = body.upstreamDown ? Math.floor(Math.random() * 45_000) : 0;
    const spacing = (body.upstreamDown ? OUTAGE_RETRY_SPACING_MS : 5_000) + jitter;
    const retryAfter = new Date(Date.now() + spacing).toISOString();
    // Record what THIS attempt spent before it was interrupted — the container
    // may have run paid flash/image calls before Google refused. Accumulated so
    // the budget meter reflects true outage-time spend.
    const { parked } = await store.parkJobForRetry({
      jobId, retryAfter, attemptCostUsd: body.audit?.spend?.cost });
    // Already parked by an earlier report of the same dead attempt. Say ok and
    // change nothing — recording it again would double-count the outage.
    if (!parked) return json({ ok: true, parked: true, alreadyParked: true });
    await store.recordAttempt({
      id: `att_${randomId(10)}`, jobId,
      attemptNo: (job.outage_retries || 0) + 1000, // outage waits, kept clear of real attempts
      outcome: 'error',
      audit: { upstreamDown: !!body.upstreamDown, retryable: true,
               error: String(body.error || '').slice(0, 2000), waitedAt: nowISO() },
      at: nowISO(),
    }).catch(err => console.error('could not record the outage wait', jobId, err?.message || err));
    console.log(`job ${jobId} parked: ${body.upstreamDown ? 'image service busy' : 'run interrupted'}, ` +
      `retry ${(job.outage_retries || 0) + 1}/${OUTAGE_RETRY_LIMIT}`);
    return json({ ok: true, parked: true, retryAfter });
  } else {
    // Rejected, or errored, or an outage we have now waited out for as long as
    // is reasonable. Either way the customer got nothing, so they pay nothing.
    // Returning credits is safe to attempt twice — the ledger and the database
    // both refuse a second one.
    // Keep the technical error alongside the customer-facing note. Without it a
    // failure is a dead end: the first staging job to die on the deployed system
    // reported only "something went wrong", which is useless for fixing it.
    /**
     * Keep the frame a rejected job produced.
     *
     * Not as a result — it is not one, and `reject_key` exists so nothing can
     * mistake it for one. It is evidence. Until now a rejection was a sentence
     * with nothing behind it: "no result passed our compliance checks", and the
     * image itself deleted with the container's temp directory. Nobody could
     * check whether the checks were right.
     *
     * That is fine while you trust them and useless the moment you want to
     * measure them — and grading sixty photographs is exactly that. The
     * rejections are the half of the data that says what the strictness is
     * costing.
     */
    let rejectKey = null;
    if (body.rejectedImage?.base64) {
      rejectKey = `${job.account_id}/${job.photo_id}/${jobId}-rejected.jpg`;
      await env.PHOTOS.put(rejectKey, base64ToBytes(body.rejectedImage.base64), {
        httpMetadata: { contentType: 'image/jpeg' },
      }).catch(err => { console.error('could not keep the rejected frame', jobId, err?.message || err); rejectKey = null; });
    }
    const finished = await store.finishJob({
      jobId,
      status: body.outcome === 'error' ? 'failed' : 'rejected',
      rejectKey,
      rejectionNote: (body.retryable ?? body.upstreamDown)
        ? 'We could not get this one through after several tries, so it was stopped. Your credits have been returned — please try again later.'
        : body.note || 'No compliant result was produced.',
      costUsd: body.audit?.spend?.cost,
      at: nowISO(),
    });
    if (finished.changed) await notifyJobFinished(env, store, { ...job, status: body.outcome === 'error' ? 'failed' : 'rejected' }, ctx);
    // The refund race, callback edition (audit, 3 Sep 2026): a late rejection
    // callback for a job that already delivered (a retried container, a stale
    // slot) must not return the credits for a photo the customer has.
    const alreadyDelivered = !finished.changed && finished.job && finished.job.status === 'delivered';
    // Record the audit for a REJECTION too, not only for an error. A job rejected
    // by the checks is the other case where someone will ask "why?" — Kyle's
    // 26 Aug declutter came back rejected and the database held nothing but the
    // customer-facing sentence, which explains nothing to anyone fixing it.
    if (body.error || body.audit) {
      const audit = auditSummary(body.audit) || {};
      if (body.error) audit.error = String(body.error).slice(0, 2000);
      await store.recordAttempt({
        id: `att_${randomId(10)}`, jobId, attemptNo: (body.attemptsUsed || 0) + 1,
        outcome: body.outcome === 'error' ? 'error' : 'rejected',
        audit, at: nowISO(),
      }).catch(err => console.error('could not record the attempt', err));
    }
    if (alreadyDelivered) {
      console.warn('refund skipped: rejection callback arrived after delivery', jobId);
    } else {
      try {
        const ledger = await store.ledgerFor(job.account_id);
        const { entry, applied } = ledger.returnCreditsForJob({
          key: `${jobId}:return`, jobId, reason: body.note || 'no compliant result', at: nowISO(),
          delivered: alreadyDelivered,
        });
        if (applied) await store.appendEntry(job.account_id, { ...entry, jobId });
      } catch (err) {
        console.error('credit return failed', jobId, err?.code || err);
      }
    }
  }

  if (Number.isInteger(body.attemptsUsed)) {
    await store.setAttemptsUsed(jobId, body.attemptsUsed);
  }
  return json({ ok: true });
}

/**
 * Google, reached from the Worker because the container cannot reach it directly
 * (Round 27: Google refuses the container's egress addresses).
 *
 * WHAT THIS HOP COSTS, MEASURED
 * A Worker's outbound fetch is cut off at Cloudflare's proxy read timeout —
 * 125 seconds, raisable on Enterprise plans only — and the Worker receives a
 * synthesised `524` as though Google had sent it. So any generation Google takes
 * longer than about two minutes to produce fails here, however healthy it is at
 * the far end. Measured 26 Aug 2026 with a throwaway probe Worker forwarding a
 * real 2K generation: `{"status":524,"ms":125037}`.
 *
 * There WAS a keepalive here that dripped whitespace into a streamed response,
 * on the theory that the edge was killing our slow REPLY. The same probe showed
 * a Worker that says nothing at all for 150 seconds still returns fine, so that
 * theory was wrong and the code did nothing but add a protocol between two of our
 * own components — one that broke a job the first time the two were deployed out
 * of step. It has been removed rather than kept as decoration.
 *
 * What would actually lift the ceiling is not being on this hop: Vertex AI, which
 * accepts server-to-server calls from the container directly and needs no proxy.
 * That is the standing backup plan, not yet built. Until then a slow Google means
 * failed jobs with credits returned, and the customer is told it was the image
 * service, not their photograph.
 *
 * The pipeline's own retry sees the 524 exactly as Google's, so nothing about its
 * behaviour changes.
 */
async function proxyToGoogle(tail, request, env) {
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/${tail}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: request.body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}

/**
 * What is worth keeping from a pipeline audit, and nothing else.
 *
 * The full record carries container file paths and every judge's prose, which is
 * megabytes over a season of jobs and useless without the machine that wrote it.
 * These are the fields that answer a customer complaint: what each check decided,
 * what the colour numbers were, what was removed, whether the disclosure landed.
 */
export function auditSummary(audit) {
  if (!audit || typeof audit !== 'object') return null;
  const attempts = Array.isArray(audit.attempts) ? audit.attempts : [];
  const out = {
    type: audit.type ?? null,
    outcome: audit.outcome ?? null,
    imageSize: audit.imageSize ?? null,
    // Which size was asked for, why, and what was handed in. Without these a
    // delivered file's dimensions cannot be explained after the fact.
    imageSizeChosenBy: audit.imageSizeChosenBy ?? null,
    source: audit.source ?? null,
    colour: audit.colour ?? null,
    watermark: audit.watermark ?? null,
    timing: audit.timing?.totalSeconds ?? null,
    // Staging only, and small: the brief that produced a look and the ranking
    // that chose it. Kyle called one staging result "perfect staging" on 26 Aug
    // and the record could not say which of the three briefs made it — which is
    // the one thing worth knowing about a result somebody liked.
    briefs: Array.isArray(audit.briefs)
      ? audit.briefs.slice(0, 6).map(b => ({ attempt: b.attempt ?? null, seed: b.seed ?? null, concept: (b.concept || '').slice(0, 240) }))
      : null,
    ranking: audit.ranking ? { order: audit.ranking.order, scores: audit.ranking.scores } : null,
    attempts: attempts.slice(0, 8).map(a => ({
      attempt: a.attempt ?? a.candidate ?? null,
      source: a.source ?? null,
      pass: a.verdict?.pass ?? null,
      votes: a.verdict ? `${a.verdict.passes}/${a.verdict.votes}` : null,
      violations: (a.verdict?.violations || []).slice(0, 4),
      colour: a.colour ?? null,
      removal: a.removal ? { removedAnything: a.removal.removedAnything, items: (a.removal.items || []).slice(0, 6) } : null,
      // What the declutter scope checks concluded — clutter left behind, and
      // furnishings wrongly taken. Dropping this was an oversight: the first
      // live run after they shipped had nothing stored about the very checks
      // that were on trial.
      scope: a.scope ? {
        remaining: (a.scope.remaining || []).map(r => ({ key: r.key, votes: r.votes, where: r.where })),
        noted: (a.scope.noted || []).map(r => r.key),
        overreach: (a.scope.overreach || []).slice(0, 6),
        errors: a.scope.errors || [],
      } : null,
      realism: a.realism?.worst ?? null,
      // WHO KILLED IT, for candidates that passed the judges and then died at a
      // later gate (structure / realism / design-score / watermark). Without
      // this the stored audit read pass=true with no violations — a mystery
      // (Kyle, 31 Aug 2026, chasing a Luxury staging that "passed" and never
      // delivered).
      killedBy: a.killedBy ?? null,
      structure: a.structure && (a.structure.violations || []).length
        ? { violations: a.structure.violations.slice(0, 4).map(v => String(v).slice(0, 300)) }
        : null,
      error: a.error ? String(a.error).slice(0, 300) : null,
    })),
  };
  // A row that will not fit is worse than a shorter one: D1 would reject the whole
  // insert and the job would have no record at all.
  const text = JSON.stringify(out);
  return text.length > 12000 ? { truncated: true, type: out.type, outcome: out.outcome, colour: out.colour } : out;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * What the person sees, in their words. They came for the image; the credit is a
 * consolation, never the goal. So a job that is merely waiting out high demand is
 * described as on its way and explicitly not charged — not as an error — and the
 * refund line appears only when the image genuinely could not be produced.
 */
function customerMessage(job, waitingOnUpstream) {
  if (job.status === 'delivered') return 'Your work is ready.';
  if (waitingOnUpstream) {
    return 'High demand right now — your photo is queued and will be delivered as soon as capacity frees up, usually within a few minutes. If it cannot be delivered, your credits come back automatically.';
  }
  if (job.status === 'failed') {
    // The true last resort: every model was down past the retry window.
    return 'We could not complete this within our retry window, so your credit has been returned. Please try again shortly.';
  }
  if (job.status === 'rejected') {
    return 'This one did not pass our quality and compliance checks, so your credit has been returned rather than delivering a photo we would not stand behind.';
  }
  return null;
}

async function jobStatus(jobId, account, store) {
  const job = await store.jobById(jobId);
  // Same answer for someone else's job as for one that does not exist, so job ids
  // cannot be probed to learn what other accounts are working on.
  if (!job || job.account_id !== account.id) return fail(404, 'NOT_FOUND', 'No such job.');
  // A job waiting out a Google outage is still running as far as the agent is
  // concerned — it has not failed, nothing has been charged, and it will finish.
  // Saying so is the whole point of the retry queue; showing "queued" with no
  // explanation while a photo sits for ten minutes would be worse than the error
  // it replaced.
  const waitingOnUpstream = !job.finished_at && (job.outage_retries || 0) > 0;
  return json({
    jobId: job.id,
    status: job.status,
    transformation: job.transformation,
    attemptsUsed: job.attempts_used,
    attemptsAllowed: job.attempts_allowed,
    resultUrl: job.result_key ? `/api/photos/${encodeURIComponent(job.result_key)}` : null,
    // Runner-up versions that passed the same checks — "Version 2"/"Version 3".
    variantUrls: variantUrlsFor(job),
    note: job.rejection_note,
    waitingOnUpstream,
    waitingSince: waitingOnUpstream ? job.created_at : null,
    // Plain language for the person waiting. They came for a photograph, not a
    // status code — and the one thing they must never wrongly believe is that
    // they have been charged for nothing. See customerMessage().
    customerMessage: customerMessage(job, waitingOnUpstream),
  });
}

/**
 * Everything this account has run.
 *
 * WHY THIS EXISTS
 * The app was built around one photograph at a time, and the only place a result
 * ever appeared was the screen that was watching the job. Close the tab and the
 * finished photograph still existed — in storage, paid for, permanent — with
 * nowhere to see it from.
 *
 * Kyle, describing the workflow he actually wants: queue three or four images,
 * *"close their phone, come back to it a couple minutes later, and they're all
 * done."* The server side of that has worked for a while: jobs run without a
 * browser attached, the retry queue keeps them alive, results are stored. What
 * was missing was somewhere to come back TO.
 *
 * Deliberately small. It answers "what have I got, and is it ready", which is
 * everything the queue screen needs and nothing an audit trail belongs in.
 */
async function jobList(account, store) {
  const rows = await store.jobsForAccount(account.id, 60);
  return json({
    jobs: rows.map(j => ({
      jobId: j.id,
      // So a failed card can offer "run it again" without a re-upload — the
      // photo is still ours, only the job ended.
      photoId: j.photo_id,
      transformation: j.transformation,
      style: j.style,
      roomType: j.room_type,
      status: j.status,
      // "Still going" and "waiting on Google" are both unfinished, and the
      // difference matters to someone deciding whether to keep waiting.
      waitingOnUpstream: !j.finished_at && (j.outage_retries || 0) > 0,
      originalUrl: j.original_key ? `/api/photos/${encodeURIComponent(j.original_key)}` : null,
      resultUrl: j.result_key ? `/api/photos/${encodeURIComponent(j.result_key)}` : null,
      variantUrls: variantUrlsFor(j),
      // What it produced but we would not deliver. Deliberately a separate field
      // from resultUrl so nothing can render a rejected frame as a finished one.
      rejectUrl: j.reject_key ? `/api/photos/${encodeURIComponent(j.reject_key)}` : null,
      // The grid's small copy: the result if there is one, else the original,
      // shrunk on first request (see servePreview). The web still shows the
      // full photo; the app asks for this.
      previewUrl: (j.result_key || j.original_key)
        ? `/api/photos/${encodeURIComponent(j.result_key || j.original_key)}?preview=1` : null,
      note: j.rejection_note,
      startedAt: j.created_at,
      finishedAt: j.finished_at,
    })),
  });
}

/**
 * `GET /api/jobs/zip?ids=a,b,c` — the chosen finished results as one ZIP.
 *
 * Only this account's delivered jobs are included; anything else in the list
 * is silently left out (the same rule as everywhere: a miss looks like
 * nothing, never like "that one belongs to someone else"). Staging's extra
 * passing versions ride along as "-version-2" and "-version-3". Names are
 * numbered in the order the customer picked them, so a listing's set stays
 * in order in the Files app.
 */
const ZIP_MAX_JOBS = 60;
async function jobsZip(url, account, env, store) {
  const ids = String(url.searchParams.get('ids') || '')
    .split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]+$/.test(s)).slice(0, ZIP_MAX_JOBS);
  if (!ids.length) return fail(400, 'BAD_REQUEST', 'Pick at least one photo.');
  const own = await store.jobsForAccount(account.id, 500);
  const byId = new Map(own.map(j => [j.id, j]));
  const entries = [];
  let n = 0;
  for (const id of ids) {
    const j = byId.get(id);
    if (!j || j.status !== 'delivered' || !j.result_key) continue;
    n++;
    const keys = [j.result_key];
    try { const v = JSON.parse(j.variant_keys || '[]'); if (Array.isArray(v)) keys.push(...v); } catch {}
    keys.forEach((key, k) => {
      if (typeof key !== 'string' || !key.startsWith(`${account.id}/`) || key.endsWith('-result-clean.jpg')) return;
      const name = `listing-lab-${String(n).padStart(2, '0')}-${j.transformation}${k ? `-version-${k + 1}` : ''}.jpg`;
      entries.push({ name, open: async () => { const o = await env.PHOTOS.get(key); return o ? o.body : null; } });
    });
  }
  if (!entries.length) return fail(404, 'NOT_FOUND', 'None of those photos are ready to download.');
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(zipStream(entries), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="listing-lab-${stamp}.zip"`,
      'cache-control': 'private, no-store',
    },
  });
}

/* ---------------------------------------------------------------------- utils */

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new AuthError('BAD_REQUEST', 'Expected a JSON body.'); }
}
