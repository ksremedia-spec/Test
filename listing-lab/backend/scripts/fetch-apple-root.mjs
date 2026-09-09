/**
 * Fetch "Apple Root CA - G3" and write it into src/apple-root.js.
 *
 *   node scripts/fetch-apple-root.mjs
 *
 * It downloads the DER certificate Apple publishes, prints the subject and
 * SHA-256 fingerprint, and rewrites APPLE_ROOT_CA_G3_BASE64 in
 * src/apple-root.js. COMPARE the fingerprint it prints with the one on
 * https://www.apple.com/certificateauthority/ before deploying — this
 * certificate is what decides whether a purchase is Apple's.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const URL = 'https://www.apple.com/certificateauthority/AppleRootCA-G3.cer';
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'apple-root.js');

const res = await fetch(URL);
if (!res.ok) { console.error(`Apple answered ${res.status} for ${URL}`); process.exit(1); }
const der = new Uint8Array(await res.arrayBuffer());
const cert = new X509Certificate(Buffer.from(der));
if (!/Apple Root CA - G3/.test(cert.subject)) {
  console.error('That does not look like Apple Root CA - G3:\n' + cert.subject);
  process.exit(1);
}
console.log('Subject:         ' + cert.subject.replace(/\n/g, ', '));
console.log('Valid:           ' + cert.validFrom + ' → ' + cert.validTo);
console.log('SHA-256:         ' + cert.fingerprint256);
console.log('Compare the fingerprint with https://www.apple.com/certificateauthority/ before you deploy.');

const b64 = Buffer.from(der).toString('base64');
const src = readFileSync(target, 'utf8');
const out = src.replace(/export const APPLE_ROOT_CA_G3_BASE64 = '[^']*';/, `export const APPLE_ROOT_CA_G3_BASE64 = '${b64}';`);
if (out === src) { console.error('Could not find the constant to replace in ' + target); process.exit(1); }
writeFileSync(target, out);
console.log('Written to ' + target + ' (' + der.length + ' bytes). Now: npm test && npx wrangler deploy');
