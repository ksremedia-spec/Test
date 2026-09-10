/**
 * Listing Lab — telling a phone its photo is done (push notifications, 10 Sep 2026).
 *
 * The iPhone app registers its device token at POST /api/devices. When a job
 * finishes — delivered, rejected or failed — the Worker sends one short
 * message to every phone on the account through Apple's push service (APNs),
 * signed with the key Kyle downloads from Apple's developer site:
 *
 *   APNS_KEY_ID        the ten-character id of that key
 *   APNS_TEAM_ID       the Apple Developer team (6YCK9MG5RD)
 *   APNS_PRIVATE_KEY   the .p8 file's contents, PEM, set with `wrangler secret put`
 *
 * With any of the three missing, nothing is sent and nothing breaks: the
 * app still polls, as it always did. A token Apple says is dead (410, or 400
 * BadDeviceToken) is forgotten so it is never tried again.
 */
import { APP_BUNDLE_ID } from './apple.js';

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',   // Xcode builds run against this one
};
/** Apple accepts a signing token for an hour; a new one every fifty minutes keeps clear of the edge. */
export const APNS_TOKEN_TTL_MS = 50 * 60 * 1000;

/** The customer labels the website uses for the four fixes. */
export const JOB_LABELS = { declutter: 'Declutter', staging: 'Virtual Staging', twilight: 'Twilight', empty: 'Empty Room' };

export function pushConfigured(env) {
  return Boolean(env?.APNS_KEY_ID && env?.APNS_TEAM_ID && env?.APNS_PRIVATE_KEY);
}

/** One line for the phone. Delivered, or came back (both rejected and failed return credits). */
export function jobFinishedMessage(job) {
  const label = JOB_LABELS[job.transformation] || 'photo';
  return job.status === 'delivered'
    ? `Your ${label} is ready.`
    : `Your ${label} came back — credits returned.`;
}

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = obj => b64url(enc.encode(JSON.stringify(obj)));

/** The .p8 file is PEM; WebCrypto wants the DER inside it. */
async function importSigningKey(pem) {
  const body = String(pem).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

let tokenCache = { token: null, issuedAt: 0, keyId: null };
/** Tests use this so one test's key never signs for the next. */
export function resetApnsTokenCache() { tokenCache = { token: null, issuedAt: 0, keyId: null }; }

/**
 * The bearer token APNs wants: a JWT signed ES256 with the .p8 key, naming
 * the key id and the team. Cached, because Apple refuses a fresh one on
 * every request ("TooManyProviderTokenUpdates").
 */
export async function apnsToken(env, now = Date.now()) {
  if (tokenCache.token && tokenCache.keyId === env.APNS_KEY_ID && now - tokenCache.issuedAt < APNS_TOKEN_TTL_MS) {
    return tokenCache.token;
  }
  const key = await importSigningKey(env.APNS_PRIVATE_KEY);
  const header = b64urlJson({ alg: 'ES256', kid: env.APNS_KEY_ID });
  const claims = b64urlJson({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) });
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  const token = `${header}.${claims}.${b64url(signature)}`;
  tokenCache = { token, issuedAt: now, keyId: env.APNS_KEY_ID };
  return token;
}

/**
 * Send one message to one phone. Answers { ok, status, reason, gone }:
 * `gone` means Apple says that token will never work again and the caller
 * should forget it. Never throws — a push is a courtesy, and a failure to
 * send one must not touch the job it is about.
 */
export async function sendPush(env, device, { body, jobId }, opts = {}) {
  const doFetch = opts.fetch || fetch;
  const host = APNS_HOSTS[device.environment] || APNS_HOSTS.production;
  try {
    const token = await apnsToken(env, opts.now);
    const res = await doFetch(`${host}/3/device/${device.token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'apns-topic': env.APPLE_BUNDLE_ID || APP_BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ aps: { alert: { body }, sound: 'default' }, jobId }),
    });
    let reason = null;
    if (!res.ok) { try { reason = (await res.json())?.reason || null; } catch { reason = null; } }
    const gone = res.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic';
    if (!res.ok) console.warn('push refused', res.status, reason, device.environment);
    return { ok: res.ok, status: res.status, reason, gone };
  } catch (err) {
    console.error('push failed', err?.message || err);
    return { ok: false, status: 0, reason: String(err?.message || err), gone: false };
  }
}
