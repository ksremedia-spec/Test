# Listing Lab — Customer API Reference for the Native iOS App

Generated from the backend source on 2026-09-09 (`src/worker.js`, `src/auth.js`, `src/ledger.js`, `src/store.js`, `src/stripe.js`, `src/zip.js`, `schema.sql`, `migrations/*.sql`, `container/server.js`, `pipeline/prompts.js`, and the web client `web/app.html`). Every field name below is quoted verbatim from the code. Where the code is ambiguous or silent, the text says so explicitly rather than guessing.

---

## 0. Conventions that apply to every endpoint

### Base URL

- Production: `https://thelistinglab.app` (`SITE_URL` in `wrangler.toml`).
- Any request to `http://…` or to `www.thelistinglab.app` is answered with a **301** to `https://thelistinglab.app<same path+query>`. Do not follow redirects on POST bodies; just always use the canonical origin.
- Every response carries `strict-transport-security: max-age=31536000; includeSubDomains`, `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy`, `permissions-policy`. None of this affects a native client.
- There are **no CORS headers** anywhere. A native client is not subject to CORS, so this is irrelevant to iOS, but it means the API cannot be called from a third-party web origin.

### Request bodies

- JSON endpoints read the body with `request.json()`. The `content-type` request header is not checked, but send `content-type: application/json` anyway.
- A body that is not valid JSON (including an empty body on a JSON endpoint) produces **400** `{"error":{"code":"BAD_REQUEST","message":"Expected a JSON body."}}`.
- Unknown JSON fields are ignored.

### Response bodies

- Every JSON response is sent with `content-type: application/json; charset=utf-8`.
- Success shapes are documented per endpoint.
- **Every error** has exactly this shape:

  ```json
  { "error": { "code": "UPPER_SNAKE_CODE", "message": "Plain-English sentence safe to show the customer." } }
  ```

  `message` is written to be shown to a customer as-is (the web client displays it verbatim in most places). `code` is stable and is what the app should branch on.

- An unexpected server error is **500** `{"error":{"code":"INTERNAL","message":"Something went wrong on our end."}}`. No stack traces or database messages are ever returned.

### Error codes that can come from the shared error mapper (`errorResponse`)

These are raised by `LedgerError` / `AuthError` and mapped to HTTP status:

| code | status |
|---|---|
| `INSUFFICIENT_CREDITS` | 402 |
| `ATTEMPTS_EXHAUSTED` | 409 (internal; not reachable from the customer API today) |
| `JOB_ALREADY_CHARGED` | 409 (internal) |
| `CREDITS_ALREADY_RETURNED` | 409 (internal) |
| `EMAIL_TAKEN` | 409 |
| `UNKNOWN_TRANSFORMATION` | 400 |
| `UNKNOWN_STYLE` | 400 |
| `UNKNOWN_ROOM` | 400 |
| `WEAK_PASSWORD` | 400 |
| `INVALID_EMAIL` | 400 |
| `BAD_REQUEST` | 400 (default for any other `AuthError`/`LedgerError` code) |

Per-endpoint codes returned directly via `fail(status, code, message)` are listed with each endpoint.

### Unknown routes

- Under `/api/`, a path that matches nothing returns **404** `{"error":{"code":"NOT_FOUND","message":"No such endpoint."}}` — **but only after the auth gate**, so an unauthenticated request to an unknown `/api/…` path gets **401 `NOT_SIGNED_IN`** first.

### Rate limits (`rateLimited`)

Applied only to **POST** on these four paths, keyed on `<path>:<client IP>` (`cf-connecting-ip`), via Cloudflare rate-limit bindings configured in `wrangler.toml`:

| path | binding | limit |
|---|---|---|
| `POST /api/signin` | `LIMIT_AUTH` | 10 requests / 60 s / IP |
| `POST /api/signup` | `LIMIT_AUTH` | 10 requests / 60 s / IP (separate counter from signin because the key includes the path) |
| `POST /api/redeem` | `LIMIT_REDEEM` | 5 requests / 60 s / IP |
| `POST /api/support` | `LIMIT_SUPPORT` | 3 requests / 60 s / IP |

When exceeded: **429** with header `retry-after: 60` and body
`{"error":{"code":"RATE_LIMITED","message":"Too many attempts — please wait a minute and try again."}}`.

The rate-limit check runs **before** authentication and before the body is read. No other endpoint is rate-limited by the Worker (Cloudflare's platform-level protections may still apply).

### Endpoints that exist but the app must never call

- `POST /api/stripe/webhook` — Stripe calls this with a `stripe-signature` header. It is how credits get granted after a purchase. Calling it yourself will get **400** with a `StripeVerificationError` code (`MISSING_SIGNATURE`, `MALFORMED_SIGNATURE`, `SIGNATURE_MISMATCH`, `TIMESTAMP_OUT_OF_TOLERANCE`, …). Never call it.
- Everything under `/internal/…` — `/internal/jobs/:id/result`, `/internal/jobs/:id/heartbeat`, `/internal/photos/…`, `/internal/gemini/…` (the pipeline container's back-channel, guarded by a shared secret), `/internal/board…`, `/internal/grade…`, `/internal/diag/egress` (owner-only tooling). These answer **401/404** without the secret. Never call them.

---

## 1. Authentication and sessions

### How a session works

- Signing up or signing in returns a `set-cookie` header creating the session cookie. **Cookie name: `ll_session`.** Value: 64 lowercase hex characters (32 random bytes). The server stores only a SHA-256 hash of the value.
- Exact `Set-Cookie` value produced (`sessionCookie` in `src/auth.js`):

  ```
  ll_session=<64 hex>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure
  ```

  `Max-Age=2592000` = **30 days** (`SESSION_TTL_DAYS = 30`). `Secure` is present in production (omitted only when `SITE_URL` is `http://localhost:8787`).
- The session row's `expires_at` is set to creation time + 30 days and is **never extended** on use — there is no sliding expiry. After 30 days the cookie is rejected regardless of activity and the app must sign in again.
- Multiple concurrent sessions per account are allowed (each sign-in creates a new row). Sign-out deletes only the session whose cookie was sent.
- Every request to a protected endpoint must send `Cookie: ll_session=<value>`. The server reads the `cookie` header, splits on `;`, and looks for the part whose name is exactly `ll_session`.
- Missing, unknown, or expired session on a protected endpoint → **401** `{"error":{"code":"NOT_SIGNED_IN","message":"Sign in to continue."}}`.
- **Google-only accounts** (created via the Google flow) have no password; they can only be entered via Google. Password sign-in on such an email returns `BAD_CREDENTIALS`.

### What the native app should do

1. On `POST /api/signup` or `POST /api/signin` (or after the Google flow, see §2.4), read the `set-cookie` header and extract the `ll_session` value. If you use `URLSession` with the default `HTTPCookieStorage.shared`, Foundation will store and resend it automatically; the `HttpOnly` attribute does not restrict native code. If you manage it yourself, keep the value in the **Keychain** (it is a bearer credential equivalent to a password for 30 days).
2. Send `Cookie: ll_session=<value>` on **every** `/api/…` request including image `GET`s (`/api/photos/<key>`) and the ZIP download — those are session-gated too. If you display images with a mechanism that does not use the shared cookie storage, attach the header manually.
3. Treat any **401 `NOT_SIGNED_IN`** from any endpoint (except signin/signup/me) as "session is gone": clear the stored cookie and return to the sign-in screen. (This is exactly what the web client does — it reloads to the sign-in form.)
4. Record the sign-in time and proactively re-authenticate before 30 days if you want to avoid a surprise 401.

### 1.1 `POST /api/signup`

Create an email+password account and start a session.

- Auth: none. Rate limit: 10/min/IP.
- Body (JSON):

| field | type | rules |
|---|---|---|
| `email` | string, required | Trimmed and lowercased by the server (`normaliseEmail`). Must match `^[^@\s]+@[^@\s.]+\.[^@\s]+$` (something@domain.tld; the part immediately after `@` may not contain a dot, so `a@b.c.d` is **valid** because `[^@\s.]+` matches `b` and `.c.d` matches the rest) and must **not** contain any of `< > " ' \` \`. Stored lowercased. |
| `password` | string, required | Must be a string of **at least 8 characters** (`hashPassword`). No other rule (no digit/case requirement, no maximum). Non-string → coerced with `String(body.password ?? '')` then rejected as too short. |
| `name` | any, optional | Stored as given (`body.name ?? null`). **Not validated or truncated** — send a short string or omit. |
| `company` | any, optional | Same as `name`. |

- Success: **201**, `Set-Cookie: ll_session=…` (see above), body:

  ```json
  { "account": { "id": "acct_<24 hex>", "email": "agent@example.com", "name": null, "company": null } }
  ```

- Errors:
  - 400 `INVALID_EMAIL` — "Enter an email address." / "That does not look like an email address."
  - 400 `WEAK_PASSWORD` — "Use at least 8 characters."
  - 409 `EMAIL_TAKEN` — "That email already has an account." (also returned if the address belongs to a Google-only account)
  - 400 `BAD_REQUEST`, 429 `RATE_LIMITED`, 500 `INTERNAL`
- There is **no email verification** step. The account is usable immediately.

### 1.2 `POST /api/signin`

- Auth: none. Rate limit: 10/min/IP.
- Body: `{ "email": string, "password": string }`. Email is normalised the same way as signup.
- Success: **200**, `Set-Cookie: ll_session=…`, body `{ "account": { "id", "email", "name", "company" } }`.
- Errors:
  - 401 `BAD_CREDENTIALS` — "That email and password do not match." Returned for a wrong password, an unknown email, **a malformed email**, a Google-only account, or an erased account. The server deliberately takes the same time in all cases.
  - 400 `BAD_REQUEST`, 429 `RATE_LIMITED`, 500 `INTERNAL`

### 1.3 `POST /api/signout`

- Auth: optional. If a valid `ll_session` cookie is sent, that session row is deleted. Without one, it still returns 200.
- Body: not read. The web client sends `{}`; send an empty JSON object.
- Success: **200** `{ "ok": true }` with `Set-Cookie: ll_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`.
- Delete the cookie from local storage on success (and on failure — the session may already be gone).

### 1.4 `GET /api/me`

- Auth: **required**.
- Success: **200** `{ "account": { "id", "email", "name", "company" } }`.
- Errors: 401 `NOT_SIGNED_IN`.
- The web client calls this on launch to decide whether to show the studio or the sign-in form. Do the same.

---

## 2. Google sign-in

### 2.1 `GET /api/auth/config`

- Auth: none.
- Success: **200** `{ "google": true | false }` — `true` only when the server has a Google OAuth client configured. If `false`, do not show a Google button. (The web client hides the button unless this returns `true`.)

### 2.2 `GET /api/auth/google` (start)

- Auth: none.
- Response: **302** to `https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=https://thelistinglab.app/api/auth/google/callback&response_type=code&scope=openid%20email%20profile&state=<48 hex>&prompt=select_account`, plus a state cookie:

  ```
  ll_gstate=<48 hex>; Max-Age=600; Path=/api/auth/google/callback; HttpOnly; Secure; SameSite=Lax
  ```

- If Google is not configured: **404** `NOT_FOUND` "Google sign-in is not configured."
- **From the iPhone app** (10 Sep 2026): `GET /api/auth/google?platform=ios&challenge=<43 base64url chars>`. The redirect to Google is identical (same client, same callback); the state cookie becomes `ll_gstate=<48 hex>.ios.<challenge>`, which is how the callback later knows to hand back a code instead of a cookie. `challenge` is `base64url(SHA-256(verifier))` for a verifier the app made up and keeps (PKCE, RFC 7636). Missing or malformed: **400** `CHALLENGE_REQUIRED` "Google sign-in did not start properly — try again."

### 2.3 `GET /api/auth/google/callback?code=…&state=…` (Google redirects here)

- Auth: none. The `ll_gstate` cookie set in 2.2 must be sent back (same browser context), and its value must equal the `state` query parameter.
- On success: **302** to `https://thelistinglab.app/app` with **two** `set-cookie` headers: the normal `ll_session=…` (30 days) and a clearing `ll_gstate=; Max-Age=0; …`.
- On any failure: **302** to `https://thelistinglab.app/app?auth_error=<code>` (also clearing `ll_gstate`). `auth_error` codes:

| code | meaning |
|---|---|
| `google_off` | server has no Google client configured |
| `state_mismatch` | `state` query param missing or not equal to the `ll_gstate` cookie |
| `google_denied` | Google sent no `code` (user cancelled) |
| `google_exchange` | code→token exchange with Google returned non-OK or no `id_token` |
| `google_unreachable` | network failure talking to Google |
| `google_token` | id_token unparseable, wrong issuer/audience, or expired |
| `google_email` | Google account has no verified email, or the email fails `normaliseEmail` |
| `google_password_account` | an account with this email already exists **and was created with a password** — the user must sign in with their password instead (no silent merge, by design) |

- Account behaviour: if no account exists for the verified Google email, one is created with `name` = Google's `name` claim, `company` = null, and an unusable password marker. If a Google-created account exists, it is signed in. The response never contains JSON — it is always a redirect to a web URL.
- **When the state cookie says `ios`** (see 2.2): on success, **302** to `https://thelistinglab.app/signin/return?code=<64 hex>` with **no** session cookie — the app makes its session in 2.5. On any failure, **302** to `https://thelistinglab.app/signin/return?error=<code>` with the same codes as the table above. Either way `ll_gstate` is cleared. The account rules are identical.

### 2.4 `GET /signin/return` — the hand-back page for the app

A static page (`web/signin-return.html`) in the site's design, served with the query string passed through. Its script opens `listinglab://signin?code=<code>` or `listinglab://signin?error=<code>` and shows an "Open Listing Lab" button for a browser that blocks the automatic jump. `noindex`. No sign-in needed.

### 2.5 `POST /api/auth/google/exchange` — the app swaps its code for a session

- Auth: none. Rate limit: `LIMIT_AUTH` (shared with sign-in/sign-up, 10/min/IP).
- Body: `{ "code": "<64 hex from the return link>", "verifier": "<the app's secret, 43–128 base64url chars>" }`.
- Server checks, in order: the code is taken out of `app_signins` in the same statement that reads it (so it works exactly once, whatever happens next); it has not expired (five minutes from the callback); `base64url(SHA-256(verifier))` equals the stored `challenge`; the account still exists.
- Success **200**, with `Set-Cookie: ll_session=…` exactly as sign-in, and the same JSON shape as Sign in with Apple:

  ```json
  { "account": { "id", "email", "name", "company" }, "session": "<64 hex — the cookie value>" }
  ```

- Every refusal is **401** `GOOGLE_CODE` "Google sign-in didn't finish — try again, or use email and password." — the web's own sentence; nothing distinguishes an expired code from a wrong verifier or a made-up code. 429 `RATE_LIMITED`.

### 2.6 How the iPhone app uses this

The app shows `GET /api/auth/google?platform=ios&challenge=…` in an `SFSafariViewController` sheet over the app (Google refuses to show its sign-in page inside an app-owned web view). Google's page, the callback and the hand-back page all run in that sheet; the sheet closes when `listinglab://signin` opens the app, and the app calls 2.5. The button shows only when 2.1 says `google: true`, as on the web. The two bounce messages are the web's: "That email already has a password account — sign in with your password." for `google_password_account`, and "Google sign-in didn't finish — try again, or use email and password." for everything else. Sign in with Apple is §11.1.

---

## 3. Credits, packs, checkout, promo codes

### Credit model (from `src/ledger.js`)

- One currency: **credits**. Balance = sum of an append-only ledger. Credits never expire.
- Cost per transformation (`TRANSFORMATION_COST`):

| `transformation` | credits |
|---|---|
| `declutter` | 2 |
| `empty` | 2 |
| `twilight` | 1 |
| `staging` | 2 |

- A job is charged in full when it starts (`debit`). If it ends `rejected` or `failed`, the full charge is returned automatically (`credit_return`). A `delivered` job is never refunded.
- `ATTEMPTS_PER_CREDIT = 3`: one charge buys the pipeline up to three internal generation attempts. This is informational for the customer.
- Do **not** hard-code the costs: `GET /api/credits` returns them as `costs` and the web client overwrites its defaults from the server.

### 3.1 `GET /api/credits`

- Auth: required.
- Success **200**:

  ```json
  {
    "balance": 12,
    "statement": [
      { "at": "2026-09-09T14:02:11.123Z", "delta": -2, "description": "Virtual Staging started" },
      { "at": "2026-09-09T13:59:00.000Z", "delta": 2,  "description": "Declutter — no result delivered, credits returned" },
      { "at": "2026-09-08T10:00:00.000Z", "delta": 10, "description": "Bought 10 credits" },
      { "at": "2026-09-07T10:00:00.000Z", "delta": 5,  "description": "Promo credits added" }
    ],
    "costs": { "declutter": 2, "empty": 2, "twilight": 1, "staging": 2 },
    "attemptsPerCredit": 3
  }
  ```

- `balance` — integer, may be 0, never negative.
- `statement` — newest first, at most 100 entries. Each entry: `at` (ISO-8601 UTC), `delta` (signed integer), `description` (string). Descriptions are generated by `Ledger.statement()`:
  - purchase: `Bought <n> credits`
  - promo: `Promo credit added` (delta 1) / `Promo credits added`
  - debit: `<Label> started` where Label ∈ `Declutter`, `Empty Room`, `Twilight`, `Virtual Staging` (or `Transformation` if unknown)
  - credit_return: `<Label> — no result delivered, credits returned`
  - adjustment: the free-text `reason`. One synthetic adjustment with description `balance brought forward` can appear if the account has a ledger checkpoint; treat it like any other line.
- No other ledger fields (job id, pack id, etc.) are exposed.

### 3.2 `GET /api/packs`

- Auth: required.
- Success **200** `{ "packs": [ { "id": "pack_10", "credits": 10, "priceCents": 1999 }, { "id": "pack_30", "credits": 30, "priceCents": 5699 }, { "id": "pack_75", "credits": 75, "priceCents": 13799 } ] }`
- Prices are **USD cents**. The web client renders `priceCents/100` as currency and `priceCents/credits/100` as "per credit", and labels `pack_30` "MOST POPULAR" client-side (not a server field).

### 3.3 `POST /api/checkout`

Starts a **Stripe hosted Checkout** session. Payment never touches this API.

- Auth: required.
- Body: `{ "packId": "pack_10" | "pack_30" | "pack_75" }`. The client never sends a price.
- Success **200** `{ "url": "https://checkout.stripe.com/c/pay/cs_…", "sessionId": "cs_…" }`.
- Errors:
  - 503 `SALES_PAUSED` — "Credit sales are temporarily paused — existing credits work normally." (owner switch)
  - 400 `UNKNOWN_PACK` — "Choose one of the credit packs."
  - 502 `CHECKOUT_FAILED` — "Could not start checkout. Try again in a moment."
  - 400 `BAD_REQUEST`, 401, 500
- Stripe session details set by the server: `mode=payment`, currency `usd`, `payment_method_types[0]=card` (Apple Pay / Google Pay appear automatically on the hosted page), `customer_email` = account email, `client_reference_id` = account id, metadata `pack_id` and `account_id`. Idempotency key is `checkout:<account>:<pack>:<minute>` — repeating the call for the same pack within the same UTC minute returns the **same** Stripe session.
- Return URLs (fixed, web):
  - success → `https://thelistinglab.app/app?purchase=success`
  - cancel → `https://thelistinglab.app/app?purchase=cancelled`
- **How credits arrive:** Stripe sends `checkout.session.completed` to `/api/stripe/webhook`; the server verifies the signature, checks `payment_status == "paid"`, `amount_total` equals the pack's `priceCents`, currency is USD, and then appends a `purchase` ledger entry keyed on the checkout session id (idempotent). This happens **asynchronously**, typically within a few seconds of the success redirect but not guaranteed to precede it. The web client re-fetches `/api/credits` 1.5 s and 4.5 s after landing on `?purchase=success`. The native app should open `url` in `SFSafariViewController`/`ASWebAuthenticationSession`, detect the return by watching for the `/app?purchase=success` or `?purchase=cancelled` URL, then poll `/api/credits` a few times (e.g. at 1.5 s, 4.5 s, 10 s) until `balance` increases. There is no endpoint to query the status of a checkout session.
- Note for the iOS team: this is a web purchase of consumable credits used by the app; whether that is acceptable under App Store rules is a product/legal decision outside this backend.

### 3.4 `POST /api/redeem`

- Auth: required. Rate limit: 5/min/IP.
- Body: `{ "code": string }`. The server does `String(body.code || '').trim().toUpperCase()` — codes are **case-insensitive**. Codes minted by the owner tool default to `LL-` followed by 12 hex characters (e.g. `LL-3F9A0C1B2D4E`); custom codes are 4–32 characters of `A–Z`, `0–9`, `-`. The web placeholder shows `LL-A1B2C3`. Do not validate format client-side beyond non-empty; let the server answer.
- Success **200** `{ "ok": true, "credits": 5, "balance": 17 }` — `credits` granted by this code, `balance` after.
- Errors (in the order the server checks):
  - 400 `NO_CODE` — "Type the code first."
  - 404 `PROMO_UNKNOWN` — "That code isn't one of ours — check the spelling."
  - 409 `ALREADY_REDEEMED` — "You've already used that code — it's one per customer."
  - 410 `PROMO_EXPIRED` — "That code has expired."
  - 410 `PROMO_USED_UP` — "That code has already been fully used."
  - 429 `RATE_LIMITED`, 400 `BAD_REQUEST`, 401, 500
- One redemption per code per account, enforced by the ledger key `promo:<CODE>:<accountId>`.

---

## 4. Photos

### Storage-key conventions (you will see these inside URLs)

All image URLs returned by the API are of the form `/api/photos/<URL-encoded R2 key>` and are **relative to the base URL**. Keys always begin with the owning account id:

| what | key |
|---|---|
| uploaded original | `acct_…/pho_…/original` |
| delivered result (stamped) | `acct_…/pho_…/job_…-result.jpg` |
| extra passing versions (staging only) | `acct_…/pho_…/job_…-result-v2.jpg`, `…-result-v3.jpg` |
| frame a rejected job produced | `acct_…/pho_…/job_…-rejected.jpg` |
| clean (unstamped) copy — **never served** | `acct_…/pho_…/job_…-result-clean.jpg` |

Slashes are percent-encoded (`%2F`) by `encodeURIComponent`. Use the URLs exactly as returned; do not construct keys yourself.

### 4.1 `POST /api/photos` — upload

- Auth: required.
- Two accepted request formats:

  **A. Raw bytes (what the web client uses)**
  - Header `content-type: image/jpeg` or `content-type: image/png` (anything after `;` is stripped). If the header is missing, the type defaults to `image/jpeg`.
  - Body: the image bytes.
  - Optional query parameter `?listingId=lst_…`.

  **B. `multipart/form-data`**
  - Part `photo` (a file part; a plain string value → 400 `NO_PHOTO` "Attach a photo."). The part's declared MIME type is used (empty → `image/jpeg`); the part's filename is echoed back as `filename` (default `photo.jpg`).
  - Optional part `listingId`.

- Validation, in server order:
  1. Type must be `image/jpeg` or `image/png` → else **415** `UNSUPPORTED_TYPE` "Upload a JPEG or PNG."
  2. Zero bytes → **400** `EMPTY_PHOTO` "That file is empty."
  3. **Magic bytes are sniffed** regardless of the declared type (`sniffImageFormat`): `FF D8 FF` = JPEG; `89 50 4E 47` = PNG; `ftyp` at offset 4 with brand `heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1|avif` = HEIC/HEIF/AVIF.
     - HEIC/HEIF/AVIF bytes → **415** `HEIC_DISGUISED` "That's an iPhone HEIC photo even though it's named like a JPEG. Reload this page — iPhone photos now convert automatically — and upload it again." (The message is web-specific; the app should show its own wording.)
     - Anything else unrecognised (e.g. WebP, GIF, TIFF, PDF) → **415** `NOT_AN_IMAGE` "That file doesn't look like a photo we can open. JPEG or PNG works best."
  4. Size > **25 MiB** (`MAX_UPLOAD_BYTES = 25 * 1024 * 1024` = 26,214,400 bytes) → **413** `PHOTO_TOO_LARGE` "That photo is over 25MB." (Checked after the whole body is read, so check client-side first to avoid wasting upload time.)
- **The server does not accept HEIC. The client must convert HEIC/HEIF to JPEG (or PNG) before upload.** See §9.
- **No server-side downscaling** of the original; it is stored byte-for-byte. Minimum dimensions are not enforced by the Worker. (The pipeline chooses output sizes itself; the app does not need to resize, but see §9 for what the web client does.)
- `listingId`: if omitted/empty, the server files the photo in the account's catch-all listing named `Uploads` (created on first use). **Ownership of a supplied `listingId` is not checked**, and a non-existent id causes a foreign-key failure → 500 `INTERNAL`. There is no customer endpoint to create or list listings. **Recommendation: never send `listingId`.**
- Success **201**:

  ```json
  {
    "photoId": "pho_<24 hex>",
    "listingId": "lst_<24 hex>",
    "filename": "photo.jpg",
    "signals": null,
    "classifying": true,
    "offers": ["declutter", "empty", "staging", "twilight"],
    "advice": {},
    "url": "/api/photos/acct_…%2Fpho_…%2Foriginal"
  }
  ```

  - `signals` is always `null` and `classifying` always `true` on upload: scene classification runs in the background **after** the response. `offers` is the full default list until the scene is known. Poll `/api/photos/:id/scene` (4.2) to narrow it.
  - `url` serves the original back (session-gated); the web client displays the local file instead of fetching it.
- Other errors: 401, 500.

### 4.2 `GET /api/photos/:photoId/scene` — scene classification result (pollable)

- Auth: required. `:photoId` must match `pho_[A-Za-z0-9]+`.
- Success **200**:

  ```json
  {
    "ready": true,
    "signals": {
      "isExterior": false,
      "removableClutter": "some",
      "furniture": "furnished",
      "stageableFloor": true,
      "why": "living room with a sofa and a few boxes"
    },
    "offers": ["declutter", "empty"],
    "advice": { "declutter": "There is not much here to remove — expect a small change." }
  }
  ```

  | field | type | meaning |
  |---|---|---|
  | `ready` | boolean | `true` once the classifier has written `signals`. While `false`, `signals` is `null`, `offers` is the full default list and `advice` is `{}`. |
  | `signals.isExterior` | boolean | outside of a building / yard / street / pool |
  | `signals.removableClutter` | `"none"` \| `"some"` \| `"lots"` \| `null` | how much a seller would tidy away; `null` = classifier could not say |
  | `signals.furniture` | `"none"` \| `"sparse"` \| `"furnished"` \| `null` | real furniture present |
  | `signals.stageableFloor` | boolean | open floor to place furniture on (`false` for bathrooms, closets, tight hallways, detail shots) |
  | `signals.why` | string ≤ 200 chars | classifier's short phrase; not customer-facing in the web app |
  | `offers` | array of transformation names | which transformations the server will **accept** for this photo (`offeredFor`). Always non-empty. |
  | `advice` | object `{ [transformation]: string }` | optional nudge per offered transformation (`adviceFor`); only keys with advice are present |

- `offers` rules (`offeredFor(signals)`):
  - no signals, or signals with neither `removableClutter` nor `furniture` → all four `["declutter","empty","staging","twilight"]`
  - `isExterior == true` → `["twilight"]` only
  - otherwise: `declutter` if `removableClutter != "none"` **or** `furniture != "none"`; `empty` additionally if `furniture != "none"`; `staging` if `stageableFloor != false` **and** `furniture != "furnished"`; if that yields nothing, all four.
  - Note `twilight` is **not** offered for a classified interior (only exteriors or unclassified photos). The server enforces the same rule at `/api/transform` (422 `NOT_APPLICABLE`).
- `advice` strings (exact):
  - `declutter` + `removableClutter == "some"`: "There is not much here to remove — expect a small change."
  - `declutter` + `removableClutter == "lots"`: "A very full room — Empty Room clears everything in one pass and succeeds more often on rooms like this."
  - `staging` + `furniture == "sparse"`: "This room still has a piece or two in it. Emptying it first usually stages better."
- Errors: 404 `NOT_FOUND` "No such photo." (also for another account's photo), 401.
- **Polling guidance (what the web client does, `pollScene`)**: wait 1.2 s, GET, repeat up to **15 times** (~18 s total); stop as soon as `ready` is `true`; stop silently on any non-2xx; on a network error keep polling. If it never becomes ready, keep offering all four transformations — the server re-checks at submission anyway. Classification usually takes a couple of seconds; the classify container is kept warm by a cron. **If classification fails server-side, `ready` stays `false` forever** — never block the UI on it.

### 4.3 `POST /api/photos/from-job` — chain a delivered result into a new starting photo

Used for "Stage this room" after an Empty Room job: the server copies the **clean, pre-watermark** frame of a delivered job into a fresh photo so the next transformation is not fed a stamped image. (Falls back to the stamped result for deliveries that predate clean copies.)

- Auth: required.
- Body: `{ "jobId": "job_…" }`.
- Success **201** — identical shape to upload:

  ```json
  { "photoId": "pho_…", "listingId": "lst_…", "filename": "photo.jpg", "signals": null, "classifying": true,
    "offers": ["declutter","empty","staging","twilight"], "advice": {}, "url": "/api/photos/acct_…%2Fpho_…%2Foriginal" }
  ```

  The new photo lands in the same listing as the job's source photo. Classification runs in the background — poll `/scene` exactly as after an upload. No credits are charged by this call.
- Errors:
  - 404 `NOT_FOUND` "No such job." (missing, or another account's), or "No such photo." if the stored result object is missing
  - 422 `NOT_DELIVERED` "Only a delivered result can be used as a new starting photo."
  - 400 `BAD_REQUEST`, 401, 500
- The web client, after this call, moves to the transformation picker with `staging` pre-selected, using the returned `url` as the preview. Note the new `photoId` is what you pass to `/api/transform`.

### 4.4 `GET /api/photos/<key>[?download=1]` — fetch an image

- Auth: required. The key is the URL-encoded R2 key exactly as returned in `url`, `originalUrl`, `resultUrl`, `variantUrls[]`, `rejectUrl`.
- Access rule: key must begin with `<your account id>/`; otherwise **404** `NOT_FOUND` "No such photo." (never 403 — keys cannot be probed). Keys ending in `-result-clean.jpg` are **always 404** — the unstamped copy is never served to anyone.
- Success **200**: raw image bytes. Headers: `content-type` = the stored type (`image/jpeg` for every result/variant/rejected frame; `image/jpeg` or `image/png` for originals, whichever was uploaded), `cache-control: private, max-age=31536000, immutable` (a key is never rewritten, so cache aggressively on-device).
- `?download=1` adds `content-disposition: attachment; filename="listing-lab-<basename>.jpg"` where basename is the last path segment with anything outside `A-Za-z0-9._-` replaced by `-` (e.g. `listing-lab-job_ab12-result.jpg`, `listing-lab-original.jpg`). Same bytes either way; a native app does not need the flag — it exists because iOS Safari ignores `<a download>`.
- Originals are served **as uploaded**, including any EXIF orientation tag — render them honouring EXIF (UIImage does). Results are produced upright by the pipeline.
- No range requests, no HEAD handling documented; treat as simple GET.

### 4.5 Disclosure watermark

Every deliverable image (`resultUrl`, `variantUrls`) is stamped by the pipeline with a small white sentence-case disclosure in a corner: `Virtually decluttered`, `Virtually emptied`, `Virtually staged`, or `Virtual twilight` (`WATERMARK_TEXT` in `pipeline/prompts.js`; twilight has carried a mark since 5 Sep 2026). **There is no unstamped variant available through any customer endpoint**, and the app must not attempt to remove or crop it. `rejectUrl` frames are not deliverables and may or may not carry a stamp.

---

## 5. Transformations (jobs)

### 5.1 Option vocabulary

Exact, closed sets enforced server-side (`src/worker.js`; the pipeline validates them again):

- `transformation` (required): `"declutter"` | `"empty"` | `"twilight"` | `"staging"`
  - Customer labels used by the web: Declutter, Empty the room / Empty Room, Twilight, Virtual staging.
- `style`:
  - for `staging` (**required**): `"Standard"` | `"Modern"` | `"Contemporary"` | `"Coastal"` | `"Luxury"` (`STAGING_STYLES`)
  - for `twilight` (optional): the only accepted value is `"Dusk"` (`TWILIGHT_MOODS`); if omitted the server defaults it to `"Dusk"`. The web sends `"Dusk"` and shows no picker.
  - for `declutter` / `empty`: **not validated** — whatever is sent is stored on the job row (`body.style ?? null`) and passed to the pipeline as `style`. Its effect on those transformations is not defined anywhere in the Worker. **Omit it.**
- `roomType` (required for `staging`, ignored otherwise but stored if sent): `"Living Room"` | `"Dining Room"` | `"Primary Bedroom"` | `"Guest Bedroom"` | `"Nursery / Kids Room"` | `"Basement / Rec Room"` | `"Home Office"` | `"Other"` (`ROOM_TYPES`). Match exactly, including the spaces around `/`.
- `options` (optional, any JSON): stored on the job as `options_json` but **never read** — it is not forwarded to the pipeline (dispatch sends only `jobId`, `transformation`, `style`, `roomType`). Effectively a no-op today. Omit it.
- **There is no `note` field on the transform request.** The word `note` appears only in *responses* (`note` = the rejection note). `schema.sql` contains a comment saying "the customer's free-text note is parsed into these before it gets here", but no code implements any customer note; the product deliberately has no free-text prompt box ("There is no free-text box and there never will be" — web client). Do not build a note field.

### 5.2 `POST /api/transform` — start a job

- Auth: required.
- Body:

  ```json
  { "photoId": "pho_…", "transformation": "staging", "style": "Modern", "roomType": "Living Room" }
  ```

  Minimal forms: `{ "photoId", "transformation": "declutter" }`, `{ "photoId", "transformation": "empty" }`, `{ "photoId", "transformation": "twilight", "style": "Dusk" }`.
- Server checks, **in order** (first failure wins):
  1. Owner brake → **503** `GENERATION_PAUSED` "AI generation is temporarily paused. Your credits are safe and never expire."
  2. Body not JSON → 400 `BAD_REQUEST`
  3. `photoId` falsy → **400** `PHOTO_REQUIRED` "Choose a photo."
  4. `transformation` not in the cost table → **400** `UNKNOWN_TRANSFORMATION` "That is not one of the four transformations."
  5. Photo not found or not yours → **404** `NOT_FOUND` "No such photo."
  6. Transformation not in `offeredFor(photo.scene)` → **422** `NOT_APPLICABLE` with one of three messages: "This room is already furnished. Empty it first, then stage it." (staging), "That only applies to interior photos. Try Twilight for an exterior." (exterior), or "That transformation does not apply to this photo."
  7. `staging` with bad `style` → **400** `UNKNOWN_STYLE` "Choose a style: Standard, Modern, Contemporary, Coastal, Luxury."; bad `roomType` → **400** `UNKNOWN_ROOM` "Choose a room type: Living Room, Dining Room, …, Other."
  8. `twilight` with a `style` that is not `"Dusk"` → **400** `UNKNOWN_STYLE` "Choose a look: Dusk."
  9. Balance pre-check → **402** `INSUFFICIENT_CREDITS` "Not enough credits for this transformation."
  10. Atomic debit loses a race for the last credits → **402** `INSUFFICIENT_CREDITS` "Not enough credits for that one."
- Success **202**:

  ```json
  { "jobId": "job_<24 hex>", "status": "queued", "balance": 8 }
  ```

  Credits are debited at this moment. The job is dispatched to the pipeline in the background.
- **Retry safety:** the call is **not** idempotent. If the request times out or the connection drops after sending, the job may have started and been charged. The web client does *not* blindly retry; it sends the user to the job list (`GET /api/jobs`) to see whether the job exists. Do the same.
- The web client's request timeout for all JSON calls is **45 s**.

### 5.3 `GET /api/jobs/:jobId` — poll one job

- Auth: required. `:jobId` matches `[A-Za-z0-9_-]+`.
- Success **200**:

  ```json
  {
    "jobId": "job_…",
    "status": "running",
    "transformation": "staging",
    "attemptsUsed": 0,
    "attemptsAllowed": 3,
    "resultUrl": null,
    "variantUrls": [],
    "note": null,
    "waitingOnUpstream": false,
    "waitingSince": null,
    "customerMessage": null
  }
  ```

  | field | type | meaning |
  |---|---|---|
  | `status` | `"queued"` \| `"running"` \| `"delivered"` \| `"rejected"` \| `"failed"` | see §5.5 |
  | `transformation` | string | as submitted |
  | `attemptsUsed` | integer | internal generation attempts the pipeline reported. **Only updated when the job finishes** (the running-time increment is dead code), so during a run it stays at 0. Do not build UI on it mid-job. |
  | `attemptsAllowed` | integer | always 3 |
  | `resultUrl` | string \| null | `/api/photos/<key>` of the delivered, stamped result; non-null only when `status == "delivered"` |
  | `variantUrls` | string[] | extra passing versions ("Version 2", "Version 3"); staging only, up to 2; usually `[]` |
  | `note` | string \| null | customer-facing reason for a `rejected`/`failed` job (the pipeline's or the sweep's sentence). `null` otherwise. |
  | `waitingOnUpstream` | boolean | `true` when the job is unfinished and has been parked at least once because the image service was busy / the run was interrupted. Show "image service busy — nothing charged"; the job is still alive. |
  | `waitingSince` | ISO string \| null | the job's creation time when `waitingOnUpstream` is true, else null |
  | `customerMessage` | string \| null | plain-language line: delivered → "Your work is ready."; waiting → "High demand right now — your photo is queued and will be delivered as soon as capacity frees up, usually within a few minutes. If it cannot be delivered, your credits come back automatically."; failed → "We could not complete this within our retry window, so your credit has been returned. Please try again shortly."; rejected → "This one did not pass our quality and compliance checks, so your credit has been returned rather than delivering a photo we would not stand behind."; queued/running (not waiting) → `null` |

- Note: this endpoint does **not** return `originalUrl`, `rejectUrl`, `photoId`, `style`, `roomType` or timestamps — use `GET /api/jobs` for those.
- Errors: 404 `NOT_FOUND` "No such job." (also for another account's job), 401.
- **Polling guidance (web client `startWatching`/`checkJob`)**: call immediately, then every **4 s**. Stop when `status` is `delivered`, `rejected`, or `failed`. Keep polling through transient network errors; on a **404** treat the job as lost/failed. The web shows a progress estimate that eases toward 90% over a per-type typical duration and never claims completion: twilight ~120 s, declutter ~150 s, empty ~150 s, staging ~330 s; after 1.6× that it shows "Still going…". Normal delivery is 2–7 minutes.
- **The 15-minute give-up is server-side** (`GIVE_UP_AFTER_MS`): a cron runs every minute and any unfinished job older than 15 minutes from `created_at` is set to `failed` with credits returned and a `note` such as "This one took longer than we are willing to keep you waiting, so it was stopped. Your credits have been returned — please try again." The client therefore never needs its own give-up timer, but it is reasonable to stop foreground polling after ~16 minutes and rely on the job list. Outage retries: up to 20 parks, 90 s apart (+ up to 45 s jitter), all bounded by the same 15-minute cutoff.

### 5.4 `GET /api/jobs` — everything this account has run

- Auth: required.
- Success **200** — newest first, at most **60** jobs:

  ```json
  { "jobs": [ {
      "jobId": "job_…",
      "photoId": "pho_…",
      "transformation": "empty",
      "style": null,
      "roomType": null,
      "status": "delivered",
      "waitingOnUpstream": false,
      "originalUrl": "/api/photos/acct_…%2Fpho_…%2Foriginal",
      "resultUrl": "/api/photos/acct_…%2Fpho_…%2Fjob_…-result.jpg",
      "variantUrls": [],
      "rejectUrl": null,
      "note": null,
      "startedAt": "2026-09-09T14:02:11.123Z",
      "finishedAt": "2026-09-09T14:05:40.001Z"
  } ] }
  ```

  - `originalUrl` — the source photo (may be `null` if the photo row is gone).
  - `rejectUrl` — the frame a `rejected` job produced but the checks refused; deliberately separate from `resultUrl` so it is never shown as a finished result. The web client does not display it.
  - `startedAt` = job creation; `finishedAt` = null while unfinished.
  - No pagination; there is no way to fetch more than the latest 60.
- **Polling guidance (web `startQueueWatch`)**: refresh every **6 s** while any job is `queued` or `running`, also refreshing `/api/credits` each tick; stop when none are. On a fetch error leave the previous list on screen.
- Web card semantics: `queued`/`running` → "WORKING" (sub-line "Image service busy — nothing charged" when `waitingOnUpstream`); `delivered` → "READY"; `rejected`/`failed` → "RETURNED — Credits returned". A returned job can be re-run with a fresh `POST /api/transform` on the same `photoId` (normal charge; the failed one was already refunded). For a rejected `declutter` the web leads with "Try Empty Room".

### 5.5 Job statuses — what each means to the customer

| `status` | meaning | credits |
|---|---|---|
| `queued` | Created, or parked waiting for a retry (check `waitingOnUpstream`). Shown as "Waiting to start". | held |
| `running` | Handed to a pipeline container; work in progress. "Working on it". | held |
| `delivered` | Passed every check; `resultUrl` (and maybe `variantUrls`) available. | spent, never refunded |
| `rejected` | The pipeline produced frames but none passed the quality/compliance checks. `note` explains. | returned automatically |
| `failed` | Could not be completed: pipeline error, dispatch failure, silence, or the 15-minute cutoff. `note` explains. | returned automatically |

A job moves `queued → running → (delivered | rejected | failed)`, possibly bouncing `running → queued` on a park. Once `finishedAt` is set it never changes again.

### 5.6 `GET /api/jobs/zip?ids=job_a,job_b,…` — download a set as one ZIP

- Auth: required.
- Query `ids`: comma-separated job ids; each must match `[A-Za-z0-9_-]+`; at most **60** are considered (extra ignored). Ids that are not yours, not `delivered`, or unknown are **silently skipped**.
- Success **200**: `content-type: application/zip`, `content-disposition: attachment; filename="listing-lab-YYYY-MM-DD.zip"`, `cache-control: private, no-store`. The body is **streamed** (no `content-length`), using ZIP "store" (no compression) with data descriptors — standard unzippers including the iOS Files app read it. Entries are named `listing-lab-NN-<transformation>.jpg` (NN = 01, 02 … in the order of `ids`), with extra versions as `listing-lab-NN-<transformation>-version-2.jpg`, `-version-3.jpg`.
- Errors: 400 `BAD_REQUEST` "Pick at least one photo." (no valid ids); 404 `NOT_FOUND` "None of those photos are ready to download."; 401.
- A native app can usually skip this and fetch `resultUrl`/`variantUrls` individually to save to the camera roll (which is what the web does when the share sheet is available; the ZIP is its fallback).

---

## 6. Problem reports and support

### 6.1 `POST /api/report` — flag a problem with one of your jobs

- Auth: required.
- Body: `{ "jobId": "job_…", "message": string }`. `message` is trimmed and **truncated to 2000 characters** server-side (the web textarea has `maxlength=2000`).
- Success **200** `{ "ok": true, "alreadyReported": false }`. `alreadyReported: true` means a report for this job already existed (one per job per account); nothing new was stored. The web shows "Already flagged — we have it." in that case.
- Errors: 400 `NO_MESSAGE` "Tell us what looks wrong first."; 404 `NOT_FOUND` "No such photo of yours."; 400 `BAD_REQUEST`; 401.
- Any job status is accepted; the web only offers it on delivered results.

### 6.2 `POST /api/support` — message a human

- Auth: **optional** (deliberately outside the auth gate so a locked-out user can reach support). Rate limit: **3/min/IP**.
- Body: `{ "message": string, "email"?: string }`. `message` trimmed and truncated to **4000** chars. If a valid session cookie is sent, the account's email is used as reply-to and `email` in the body is **ignored**. If signed out, `email` is required, trimmed, truncated to 200 chars, and must match `^[^\s@]+@[^\s@]+\.[^\s@]+$`.
- Success **200** `{ "sent": true }`.
- Errors: 400 `NO_MESSAGE` "Write a message first."; 400 `NO_EMAIL` "Add an email address so we can reply to you."; 503 `SUPPORT_DOWN` "Support is briefly unavailable — email support@thelistinglab.app directly."; 502 `SEND_FAILED` "Could not send just now — email support@thelistinglab.app directly."; 429 `RATE_LIMITED`; 400 `BAD_REQUEST`.

---

## 7. Complete endpoint index

| method | path | auth | rate limit | success |
|---|---|---|---|---|
| POST | `/api/signup` | none | 10/min | 201 + cookie |
| POST | `/api/signin` | none | 10/min | 200 + cookie |
| POST | `/api/signout` | optional | — | 200 |
| GET | `/api/auth/config` | none | — | 200 |
| GET | `/api/auth/google` | none | — | 302 → Google |
| GET | `/api/auth/google/callback` | none (state cookie) | — | 302 → `/app`, or `/signin/return` for the app |
| POST | `/api/auth/google/exchange` | none | 10/min | 200 + cookie |
| POST | `/api/support` | optional | 3/min | 200 |
| GET | `/api/me` | required | — | 200 |
| GET | `/api/credits` | required | — | 200 |
| GET | `/api/packs` | required | — | 200 |
| POST | `/api/checkout` | required | — | 200 |
| POST | `/api/redeem` | required | 5/min | 200 |
| POST | `/api/report` | required | — | 200 |
| POST | `/api/photos` | required | — | 201 |
| POST | `/api/photos/from-job` | required | — | 201 |
| GET | `/api/photos/:photoId/scene` | required | — | 200 |
| GET | `/api/photos/<key>[?download=1]` | required | — | 200 image |
| POST | `/api/transform` | required | — | 202 |
| GET | `/api/jobs` | required | — | 200 |
| GET | `/api/jobs/:jobId` | required | — | 200 |
| GET | `/api/jobs/zip?ids=` | required | — | 200 zip |
| POST | `/api/stripe/webhook` | Stripe signature | — | **do not call** |
| * | `/internal/**` | shared secret / owner | — | **do not call** |

Route-order notes that matter: `/api/photos/:id/scene` and `/api/jobs/zip` are matched **before** the generic `/api/photos/<key>` and `/api/jobs/:id` routes, so `scene` and `zip` are never mistaken for keys/ids.

---

## 8. Recommended native flow

1. **Launch** → `GET /api/me` with stored cookie. 200 → studio; 401 → sign-in screen. Also `GET /api/auth/config` to decide whether to show a Google button.
2. **Sign in / up** → `POST /api/signin` or `/api/signup`; persist `ll_session` from `set-cookie` (Keychain). Then `GET /api/credits` for `balance` and `costs` (use `costs` for every price label).
3. **Pick photos** → for each: if HEIC/HEIF (by UTType or magic bytes), convert to JPEG ≈ quality 0.92 with orientation baked in; reject > 25 MiB; `POST /api/photos` with raw bytes and `content-type: image/jpeg|image/png`, **one at a time, sequentially** (the web deliberately avoids parallel uploads on poor cellular). Keep `photoId` and `url`.
4. **Poll scene** → `GET /api/photos/{photoId}/scene` every 1.2 s, ≤15 tries; render the transformation buttons from `offers` (default all four until ready) with `advice[t]` as a sub-line. Staging needs a `style` and `roomType` picker from the closed lists in §5.1; twilight needs no picker.
5. **Start** → `POST /api/transform`; on 202 store `jobId`, update `balance`. On 402 show "Not enough credits" and offer packs; on 422 show the server `message` verbatim. On timeout/network error do **not** retry blindly — go to the job list.
6. **Poll job** → `GET /api/jobs/{jobId}` every 4 s until terminal. Show `customerMessage`/`waitingOnUpstream` state. Stop after ~16 min (server will have failed and refunded it by then).
7. **Show result** → load `resultUrl` (and `variantUrls` as "Version 2/3" for staging) with the cookie attached; before/after against the original. On `rejected`/`failed` show `note` and `customerMessage` and offer "run again" (same `photoId`, new `POST /api/transform`; for a rejected declutter, suggest `empty`). After an `empty` delivery offer "Stage this room" → `POST /api/photos/from-job` → step 4 with `staging` preselected.
8. **Save** → download `resultUrl` bytes (session cookie required) and write to the Photos library (`PHPhotoLibrary`) — this is the native equivalent of the web's share-sheet "Save to Camera Roll". Name files `listing-lab-<transformation>[-version-N].jpg` to match the web. Refresh `/api/credits` after every terminal job (a refund may have landed).
9. **Library** → `GET /api/jobs` (poll every 6 s only while something is `queued`/`running`); thumbnails from `resultUrl || originalUrl`; multi-select → save each `resultUrl`/`variantUrls` or link to `/api/jobs/zip?ids=`.
10. **Buy credits** → `GET /api/packs` → `POST /api/checkout` → open `url` in `SFSafariViewController`; on return to `/app?purchase=success` poll `/api/credits` at ~1.5 s, 4.5 s, 10 s. **Promo** → `POST /api/redeem`.
11. **Sign out** → `POST /api/signout`, then delete the stored cookie.

---

## 9. Things the web app does client-side that the native app must replicate

Taken from `web/app.html` (`toUploadable`, `uploadPhotos`, `uploadOne`, `api`):

1. **HEIC/HEIF → JPEG conversion before upload.** The server rejects HEIC bytes (415 `HEIC_DISGUISED`), even when renamed `.jpg`. The web detects HEIC by MIME (`image/heic`, `image/heif`), by extension (`.heic`, `.heif`), **and by magic bytes** (`ftyp` at offset 4 with brand `heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1`), then decodes with `createImageBitmap` (which applies EXIF orientation) and re-encodes via canvas as **JPEG, quality 0.92, at full original pixel dimensions** (no downscale). On iOS use `PHImageManager`/`CGImageDestination` or `UIImage.jpegData(compressionQuality: 0.92)` from an orientation-normalised image; requesting JPEG from PhotoKit directly is fine too. Send the result as `image/jpeg`.
2. **No downscaling.** Neither the web client nor the server resizes originals. The only client-side maximum is the **25 MiB** byte limit; the web pre-checks `file.size > 25 * 1024 * 1024` and reports "over 25MB" without uploading. There is no dimension limit. (A modern iPhone JPEG/HEIC-converted-to-JPEG is well under 25 MiB; ProRAW/48 MP exports may not be — check size and, if needed, re-encode at slightly lower quality rather than resizing.)
3. **Orientation.** For JPEG/PNG the web sends the file untouched (EXIF orientation intact) and the server/pipeline uprights it (`pipeline/orient.js`, applied in both the classifier and the transform). For HEIC conversions the orientation is baked in by the decode step. Either approach is acceptable; baking it in is safer.
4. **Magic-byte sniff of "JPEG/PNG" files** before upload so the user gets an immediate, well-worded error instead of a 415 after a full upload (the server message for `HEIC_DISGUISED` tells the user to "reload this page", which is wrong for an app).
5. **Sequential uploads and sequential job starts** — one at a time, never in parallel, for reliability on cellular. One bad file must not abort the batch: report it and continue.
6. **Upload stall timeout of 60 s that resets on every progress event** (not a fixed total timeout), so a slow-but-moving upload is never cut off. Show real byte progress (the web uses XHR for exactly this reason).
7. **45 s timeout on every JSON call**; surface "check your signal and try again" and mark the error retryable — except for `POST /api/transform`, where a timeout is ambiguous (the job may have started and been charged): send the user to the job list instead of retrying.
8. **401 handling**: any 401 (other than on signin/signup/me) → drop the session and go to sign-in.
9. **Prices and costs come from the server** (`/api/credits.costs`, `/api/packs`); the web only hard-codes them as a fallback until the first response. Closed option lists (styles, room types) are hard-coded in both web and server and must be mirrored exactly (§5.1).
10. **Affordability check before enabling Start**: `balance >= costs[transformation]` (and for a batch, the sum), to tell the user before they wait — the server enforces it again.
11. **Result naming and saving**: files named `listing-lab-<transformation>[-version-N].jpg`; "Save to Camera Roll" is the primary action, download the fallback; the disclaimer "AI can make mistakes — please double-check before it goes live." is shown under every result.
12. **Chain nudge**: after an `empty` delivery, offer "Stage this room" via `/api/photos/from-job`; after a rejected `declutter`, offer "Try Empty Room" on the same `photoId`.
13. **Poll cadences**: scene 1.2 s × 15; single job 4 s; job list 6 s while busy; credits re-fetched 1.5 s and 4.5 s after checkout return.
14. **Google sign-in**: the website's flow in a sheet, finished with a one-time code (see §2.2–2.6).

---

## 10. Things that could not be determined from the code (stated, not guessed)

- The effect, if any, of sending `style` with `declutter` or `empty` (stored and forwarded to the pipeline but unvalidated). Omit it.
- `options` on `/api/transform` is stored but never consumed by anything in this repo.
- How long webhook-driven credit grants take after Stripe's success redirect; the web assumes "a beat" and re-checks at 1.5 s and 4.5 s.
- Whether the pipeline enforces any minimum/maximum image dimensions; the Worker does not.
- `attemptsUsed` semantics mid-job: the code that would increment it during a run is documented as dead, so it is only reliable on finished jobs.

---

## 11. Endpoints added for the iOS app (9 Sep 2026)

Two routes exist only for the native app, plus one option on checkout, plus Google sign-in's app-side ending in §2.2–2.6 (10 Sep 2026). Everything in §0 applies (JSON bodies, the error shape, `Cookie: ll_session=…`). Source: `src/apple.js`, `src/worker.js`; tests: `test/apple-signin.test.js`, `test/google-ios.test.js`, `test/delete-account.test.js`, `test/checkout-ios.test.js`.

### 11.1 `POST /api/auth/apple` — Sign in with Apple

- Auth: none. Rate limit: `LIMIT_AUTH` (shared with sign-in/sign-up, 10/min/IP).
- Body:

  ```json
  { "identityToken": "<JWS from ASAuthorizationAppleIDCredential.identityToken>",
    "authorizationCode": "<optional, not used by the server>",
    "user": { "email": "…", "name": { "givenName": "…", "familyName": "…" } } }
  ```

  `user` is only present on the very first sign-in (iOS sends it once); treat it as optional. Only `user.name` is read — the email comes from the verified token, never from the body.
- Server checks: RS256 signature against Apple's JWKS (`https://appleid.apple.com/auth/keys`, cached a day, refetched once on an unknown `kid`), `iss == https://appleid.apple.com`, `aud == com.horizonhomemedia.listinglab`, `exp` in the future.
- Account rule: look up by Apple's `sub` first (`accounts.apple_sub`). If none: an existing **password** account with the token's email → `409 APPLE_PASSWORD_ACCOUNT`; an existing **Google** account → `409 APPLE_GOOGLE_ACCOUNT`; otherwise create the account (`password_hash = '$apple-only$'`, `name` from `user.name` if sent).
- Success **201** (created) or **200** (existing), with `Set-Cookie: ll_session=…` exactly as sign-in, and:

  ```json
  { "account": { "id", "email", "name", "company" }, "session": "<64 hex — the cookie value>" }
  ```

  The native app stores `session` in the Keychain and sends `Cookie: ll_session=<session>` itself.
- Errors: 400 `APPLE_TOKEN_REQUIRED`; 401 `APPLE_TOKEN` "That Apple sign-in could not be verified — try again."; 401 `APPLE_EMAIL` (Apple shared no email and no account exists yet); 409 `APPLE_PASSWORD_ACCOUNT` "That email already has a password account — sign in with your password."; 409 `APPLE_GOOGLE_ACCOUNT` "That email signed up with Google — sign in with Google on the website."; 502 `APPLE_KEYS_UNREACHABLE`; 429 `RATE_LIMITED`.
- `POST /api/signin` on an Apple account now answers 401 `APPLE_ACCOUNT` "That email signed up with Apple — use Sign in with Apple." (and 401 `GOOGLE_ACCOUNT` for Google accounts). Every other wrong sign-in is still `BAD_CREDENTIALS`.

### 11.2 `POST /api/checkout` with `platform: "ios"` — buying credits from the app

Credits are **not** sold through Apple (decided 10 Sep 2026). The app opens the website's hosted Stripe Checkout in `SFSafariViewController` and Stripe returns the person to a page that hands back to the app.

- Auth: required. Body: `{ "packId": "pack_10" | "pack_30" | "pack_75", "platform": "ios" }`. Any value other than `"ios"` (or no field) behaves exactly as the web.
- Success **200** `{ "url": "https://checkout.stripe.com/c/pay/cs_…", "sessionId": "cs_…" }` — open `url`. Errors as §3.3.
- With `platform: "ios"` the Stripe session's return URLs are `{SITE_URL}/purchase/return?status=success` and `{SITE_URL}/purchase/return?status=cancelled`. That path serves `web/purchase-return.html`, which says "Payment received — returning you to the app…" (or "No charge — returning you to the app…"), immediately opens `listinglab://purchase?status=<status>`, offers an **Open Listing Lab** button that does the same, and says "You can also just switch back to the app."
- The app registers the `listinglab` URL scheme, dismisses Safari on return, and re-reads `/api/credits` at 1.5 s and 4.5 s exactly as the web does after `?purchase=success`. Credits arrive through the Stripe webhook (§3.3) — nothing else on the server changes.
- The buy path is shown only on the United States storefront (`Storefront.current?.countryCode == "USA"`); elsewhere the app shows the packs with "Credits can be bought at thelistinglab.app" and no link.

### 11.3 `DELETE /api/me` — delete the account

- Auth: required. Rate limit: `LIMIT_AUTH`. No body.
- Effect, in order: every session for the account is deleted; every R2 object under `<accountId>/` is deleted (listed by prefix, deleted in batches); the account row is deleted, and `ON DELETE CASCADE` removes listings, photos, jobs, attempts, grades, reports and **ledger entries** (credits are forfeited). If storage refuses partway the row stays (500) and the person can sign in and try again; they are already signed out everywhere.
- Success **200** `{ "ok": true }` with `Set-Cookie: ll_session=; …Max-Age=0`.
- Errors: 401 `NOT_SIGNED_IN`, 429 `RATE_LIMITED`, 500 `INTERNAL`.
