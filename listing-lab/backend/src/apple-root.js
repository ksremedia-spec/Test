/**
 * Listing Lab — Apple's root certificate, the trust anchor for App Store
 * transactions (see src/apple.js).
 *
 * Every transaction the iOS app sends to POST /api/iap/verify is a JWS signed
 * by a certificate that chains up to "Apple Root CA - G3". The chain travels
 * inside the JWS header (x5c), so the ONE thing the server must already hold
 * is the root — anything that chains to a different root is not Apple.
 *
 * WHERE IT COMES FROM
 * Apple publishes the certificate at
 *   https://www.apple.com/certificateauthority/AppleRootCA-G3.cer   (DER)
 * and lists its fingerprint on https://www.apple.com/certificateauthority/.
 * `node scripts/fetch-apple-root.mjs` downloads it, prints the subject and
 * SHA-256 fingerprint for you to compare against Apple's page, and writes
 * the base64 of the DER bytes into the constant below.
 *
 * WHY IT MAY BE EMPTY IN THE REPOSITORY
 * The machine the iOS work was done on could not reach apple.com (network
 * policy), so the bytes could not be embedded there. An empty constant makes
 * the verifier FAIL CLOSED: every purchase is refused with
 * IAP_ROOT_NOT_CONFIGURED and the app keeps the transaction unfinished, so
 * nothing is lost — it retries once the root is in place. Run the script
 * before deploying the iOS build.
 *
 * base64 of the DER-encoded certificate. Never a PEM, never a fingerprint.
 */
export const APPLE_ROOT_CA_G3_BASE64 = '';

/** Decoded once; empty Uint8Array when not configured. */
export const APPLE_ROOT_CA_G3_DER = APPLE_ROOT_CA_G3_BASE64
  ? Uint8Array.from(atob(APPLE_ROOT_CA_G3_BASE64), c => c.charCodeAt(0))
  : new Uint8Array(0);
