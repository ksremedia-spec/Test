# Listing Lab — native iOS app: the brief

This is the one document to read first. It says what the product is, what the iOS app must do, and every decision that has already been made so nobody has to ask. Where it says **DECIDED**, build it that way. Where it says **Phase 2**, leave it out of v1 but don't paint yourself into a corner.

The backend is live at `https://thelistinglab.app` and is NOT being rewritten. The iOS app is a native client for it. Two small server additions are required and are specified in §6 — they are part of this project.

---

## 1. What Listing Lab is

AI photo enhancement built for real-estate listings. An agent uploads a listing photo, picks one of four transformations, and gets a finished image back in one to three minutes (staging a few minutes longer):

| Transformation | What it does | Credits |
|---|---|---|
| Declutter | Removes personal clutter (laundry, toiletries, cords, boxes, toys). The room's furniture, art, fixtures stay. A tidy-up, not a redesign. | 2 |
| Empty Room | Removes everything movable. What conveys with the house stays. | 2 |
| Virtual Staging | Furnishes a room to real-world scale in Standard / Modern / Contemporary / Coastal / Luxury. Delivers up to three passing versions. | 2 |
| Twilight | Daylight exterior → believable dusk. Sky and light only. (Dusk only — no other times.) | 1 |

What makes it different, and what the app must never undermine:

1. **Every result is inspected against the original before delivery** (AI inspection, twice, plus a close-up review). Anything that changed the house is rerun or refused. Credits for refused/failed jobs come back automatically.
2. **Every delivered image carries a permanent disclosure stamp** ("Virtually staged", "Virtually decluttered", "Virtually emptied", "Virtual twilight"). The app must never crop, hide, or offer a way around it. The un-stamped copy is never served by the API.
3. **No prompt box.** Closed menus only. Never expose free-text instructions to the image model.
4. **Credit packs, no subscription.** 10 / $19.99, 30 / $56.99, 75 / $137.99. Credits never expire. Purchases are non-refundable except where law requires; job credits are returned automatically.

Positioning line used everywhere: *"AI enhancement built for real estate."*

## 2. Who uses it

Real-estate agents, mostly on their phones, often standing in the listing. Non-technical. They photograph or receive photos, want them fixed fast, and need to trust that the result is safe to publish on MLS. Secondary: listing photographers.

The owner, Kyle Silva, is a working real-estate photographer (1,000+ listings, Horizon Home Media, South Coast Massachusetts) and a former licensed agent. He has next to no coding background. See `CLAUDE.md` for how he works and what he expects.

## 3. What already exists (all in this package)

- `backend/` — the whole production system: Cloudflare Worker API (`src/`), the web app and marketing site (`web/`), the image pipeline that runs in Cloudflare Containers (`pipeline/`, `container/`), database schema and migrations, tests, deploy config. Read `backend/README.md` if present, and `docs/API.md` for the contract.
- `web/app.html` — the current customer app (a single-page web app). The iOS app replaces this for iPhone users. Its behaviour, wording and decisions are documented screen by screen in `docs/APP-SCREENS.md`. **Match it.** The wording was approved by the owner; don't "improve" copy.
- `reference/LabOwner-ios/` — a small SwiftUI app the owner already has (his private back-office app). Use it as a reference for the project format that opens cleanly in his Xcode (objectVersion 77, file-system-synchronized groups), his Keychain helper, and the general code style. It is NOT the customer app.
- `assets/` — logo, icons, sample photos, the founder portrait, the social card.

## 4. Scope of v1 (DECIDED)

Build the customer app, feature-complete with the web app, plus the two native advantages (camera roll, in-app purchase). Concretely:

**Sign in / sign up.** Email + password (existing API), and **Sign in with Apple** (new — §6.1). Do NOT offer Google sign-in on iOS: it is a browser-redirect flow that only a web view can complete, and offering it would trigger Apple's Sign-in-with-Apple requirement anyway. An account created on the web with Google can't sign in on iOS — show the server's message.

**Upload.** PHPicker, multi-select (the web allows several at once; the batch flow is documented in APP-SCREENS). Convert HEIC → JPEG on device at quality 0.92, full resolution, orientation baked in (the server rejects HEIC bytes). Do not downscale. 25 MiB cap per image. Upload sequentially. Also allow taking a photo with the camera.

**Classification → offers.** After upload, poll the scene endpoint; show only the transformations the server offers for that photo, with its advice text. Exact rules in API.md §4 and APP-SCREENS §1.

**Run.** Start the job, show the progress screen with the step texts and timings from APP-SCREENS, keep polling while the app is open, and — the native advantage — keep the job list fresh when the app returns to the foreground. The customer can leave; the job finishes on the server. A job the server gives up on (15 minutes) shows the server's message and the credits are already back.

**Result.** Before/after slider, versions picker when staging produced more than one, "Save to Camera Roll" that writes the JPEG directly to the Photos library (PHPhotoLibrary, add-only permission) — better than the web's share sheet — with a system share sheet as the secondary action. The "AI can make mistakes — please double-check before it goes live." line, small and faint, exactly as on the web. The "Stage this room" nudge after Empty Room.

**My Photos.** The grid with READY / WORKING / RETURNED badges; taps behave as on the web; the returned-job sheet with the exact retry matrix; **select mode** with "Save N to Camera Roll" (direct to library) and "Download N as .zip" (via the ZIP endpoint; on iOS present it with a share sheet / save to Files).

**Credits.** Balance chip; buy credits via **In-App Purchase** (new — §6.2), not Stripe. Promo code redemption (existing API). Credit statement (from `/api/credits`).

**Account.** Show email, sign out, links to Terms / Privacy / FAQ / Who built this (open in SFSafariViewController), "Message support" (existing API), and **Delete my account** — Apple requires in-app account deletion for apps with account creation. There is no deletion endpoint today; see §6.3.

**Report a problem** on a result (existing API).

**Phase 2 (not v1):** push notification when a job finishes (needs an APNs token endpoint + server send — design so the job-polling layer can be swapped for a push wake later); iPad layout; widgets.

**Never:** a free-text prompt field; any way to remove the disclosure stamp; showing a rejected frame as a result (the API's `rejectUrl` is only for the "why it was returned" sheet); pricing that differs from the web except where Apple's price tiers force rounding.

## 5. Technical decisions (DECIDED — don't ask)

| Topic | Decision |
|---|---|
| App name | **Listing Lab** |
| Bundle identifier | `com.horizonhomemedia.listinglab` (change only if App Store Connect says it's taken) |
| Team | The owner's existing Apple Developer team (the one his Horizon Home Media app ships under). Leave `DEVELOPMENT_TEAM` empty in the project; he selects it in Xcode. |
| Minimum iOS | 17.0 |
| Language / UI | Swift 5.10+, SwiftUI only, no UIKit view controllers except where SwiftUI has no equivalent (PHPicker, SFSafariViewController, share sheet via `UIActivityViewController` wrapper). |
| Xcode | 16+. Project format like `reference/LabOwner-ios` (objectVersion 77, synchronized root group) so it opens cleanly. |
| Dependencies | **None.** No SPM packages, no CocoaPods. StoreKit 2, AuthenticationServices, Photos, PhotosUI are all in the SDK. |
| Architecture | MVVM-ish: one `APIClient` actor, one `SessionStore` (Keychain-backed), `@Observable` view models per screen. Keep it simple; this is a small app. |
| Networking | `URLSession`. Base URL `https://thelistinglab.app`. Send the session as a `Cookie: ll_session=<token>` header yourself (don't rely on the shared cookie jar). 45-second request timeout, 60-second stall timeout on uploads, as on the web. |
| Session storage | Keychain (`kSecAttrAccessibleAfterFirstUnlock`). The token is the value of the `ll_session` cookie returned by sign-in/sign-up/Apple sign-in. Sessions last 30 days, no renewal — on any 401 clear the token and show sign-in. |
| Offline | Not supported beyond a clear message. No local job queue. |
| Analytics / crash reporting | None in v1. No third-party SDKs at all. |
| Fonts | Body/UI: system font (SF). Display headings: **Fraunces** (OFL licence) — the TTFs are in `assets/fonts/`, bundle them; register in Info.plist `UIAppFonts`. The web uses Inter for UI; SF is the native equivalent — do not bundle Inter. |
| Colours | The studio (dark) register from APP-SCREENS §4 / `assets/brand.md`. The app is dark-only, like the web app. Respect Dynamic Type. |
| App icon | Make a 1024×1024 full-bleed icon from `assets/logo/logo-source-1254.png`: the camera mark centered on the brand dark ground `#0F141B` (not white). Provide light/dark/tinted variants as Xcode 16 wants. |
| Launch screen | Plain dark `#0F141B` with the mark centered. |
| Orientation | Portrait on iPhone. |
| Localisation | English only. |
| Privacy manifest | Include `PrivacyInfo.xcprivacy` (required). Data collected: email (account), photos (uploaded to our server for processing), purchase history. No tracking. See `docs/APP-STORE.md`. |
| Tests | Unit tests for the API client's decoding (fixtures from API.md), the HEIC→JPEG conversion, the retry-matrix logic, and the IAP receipt flow (mocked). Keep them fast. |

## 6. Backend additions required (part of this project)

The backend is a Cloudflare Worker in `backend/src/worker.js` with D1 (SQLite) via `backend/src/store.js` and a credit ledger in `backend/src/ledger.js`. Its tests are in `backend/test/` (`npm test`). Follow the existing patterns exactly — read how `googleCallback`, `redeemPromo` and the Stripe webhook are written; each new piece should look like it was written by the same hand, with the same "why this exists" comments.

### 6.1 Sign in with Apple — `POST /api/auth/apple`

Request: `{ "identityToken": "<JWS from ASAuthorizationAppleIDCredential>", "authorizationCode": "...", "user": { "email": "...", "name": { "givenName": "...", "familyName": "..." } } }` (`user` is only sent by iOS on the FIRST sign-in; treat it as optional).

Server:
1. Verify the identity token: fetch Apple's JWKS (`https://appleid.apple.com/auth/keys`, cache ~1 day), check signature (RS256), `iss == https://appleid.apple.com`, `aud == com.horizonhomemedia.listinglab`, `exp`. Use WebCrypto; no libraries.
2. Take `sub` (Apple's stable user id) and `email` (may be a private-relay address; `email_verified` may be the string "true").
3. Look up by Apple `sub` first — add a nullable, unique-indexed column `apple_sub` to `accounts` (new migration file, mirrored into `schema.sql`, like the other migrations). If found, sign that account in.
4. Else, mirror the Google rule exactly (see the "NO SILENT MERGE" comment in `googleCallback`): if an account with that email exists and it is a password account, refuse with `409 APPLE_PASSWORD_ACCOUNT` and the message "That email already has a password account — sign in with your password." If it exists and is Google-only, refuse with `409 APPLE_GOOGLE_ACCOUNT`. Otherwise create the account with `password_hash = '$apple-only$'`, `apple_sub`, email, and name from `user.name` if present.
5. Create a session exactly as `signin` does and return `{ account, session: "<token>" }` AND set the cookie. The native app reads the token from the JSON.

Also in `signin`: a `$apple-only$` account already fails password verification (the marker is not a valid hash, exactly like `$google-only$`), but give it a clearer answer — when the looked-up account's `password_hash` is `$apple-only$`, return `401 APPLE_ACCOUNT` with the message "That email signed up with Apple — use Sign in with Apple." Do the same courtesy for `$google-only$` with `401 GOOGLE_ACCOUNT` / "That email signed up with Google — sign in with Google on the website." (the web app can show that too).

Rate limit it like signin (see `rateLimited`). Add tests in `backend/test/` mirroring `auth.test.js`.

### 6.2 In-App Purchase credits — `POST /api/iap/verify`

Apple requires that digital credits consumed in the app be sold through In-App Purchase. Stripe Checkout stays for the web; the iOS app never shows Stripe.

Products (consumables), configured in App Store Connect by the owner (give him the exact list in the README):

| Product ID | Credits | Price |
|---|---|---|
| `com.horizonhomemedia.listinglab.credits10` | 10 | $19.99 |
| `com.horizonhomemedia.listinglab.credits30` | 30 | $56.99 |
| `com.horizonhomemedia.listinglab.credits75` | 75 | $137.99 |

App: StoreKit 2. Load products, show them in the same buy-credits sheet layout as the web (packs, "MOST POPULAR" on the 30). On purchase success, POST the transaction's `jwsRepresentation` to the server; only call `transaction.finish()` after the server says the credits were granted. On launch and on foreground, replay `Transaction.unfinished` through the same endpoint so a purchase interrupted by a crash or a bad connection is never lost. Also handle `Transaction.updates`.

Server:
1. Verify the JWS: decode the header's `x5c` chain, check it chains to Apple's root (`Apple Root CA - G3`; embed the root cert's DER as a constant with a comment on where it came from), verify the ES256 signature with the leaf key, and check `bundleId == com.horizonhomemedia.listinglab`, `environment` (accept `Sandbox` only when a `IAP_ALLOW_SANDBOX` var is set — the owner will set it for testing), and that `productId` is one of the three.
2. Grant credits through the ledger exactly as the Stripe webhook does, with ledger key `iap:<transactionId>` so replaying the same transaction never credits twice (the ledger's UNIQUE key is the referee — see the `creditKeyFor` comment). Entry type `purchase`.
3. Return `{ ok: true, granted: <credits>, balance: <balance>, alreadyGranted: <bool> }`.

Tests: signature verification with a fixture chain (document how the fixture was made), idempotency, wrong bundle id, sandbox gating.

Tell the owner in README what he must do in App Store Connect (create the three consumables, prices, an App Store Server API key is NOT needed for this design, set the `IAP_ALLOW_SANDBOX` var with `npx wrangler secret put` while testing). Note for him: Apple keeps 30% (15% under the Small Business Program, which he should enrol in).

### 6.3 Account deletion — `DELETE /api/me`

Apple requires it. Behaviour: sign the account out everywhere (delete sessions), delete the account row — the schema's `ON DELETE CASCADE` already removes photos, jobs, ledger, sessions — and delete the account's objects from R2 (every key under `<accountId>/`; list with a prefix, delete in batches). Return `{ ok: true }`. Rate-limit like signin. In the app: an "Delete my account" row in Account, behind a confirmation that says credits are forfeited and photos are erased, exactly as `web/privacy.html` describes erasure. Add to the FAQ answer "Are my photos private?" that deletion is also available in the iOS app — **only after** the owner approves the wording (put it in the README's "for Kyle" list, don't ship it).

### 6.4 Nothing else on the server

Every other endpoint exists. Do not change response shapes the web app depends on. Run `npm test` in `backend/` before and after; it must stay green (386 tests at hand-off).

## 7. Behaviour that must match the web exactly

APP-SCREENS.md is the spec. The non-negotiables, because the owner decided each of them on purpose:

- Offers the server didn't make are **omitted**, not shown disabled.
- One obvious action on the result screen (save to camera roll); download is a quiet secondary line.
- The result screen's fine print: "AI can make mistakes — please double-check before it goes live." at the small, faint size specified.
- A returned job explains itself in the server's words (`note`), then offers the retry matrix (rejected declutter → Empty Room first; failed → same transformation first).
- Progress steps never light the final step until delivery.
- "Waiting on Google" wording when `waitingOnUpstream` is true; nothing charged.
- Twilight is Dusk only. No time-of-day picker.
- Credits never expire; the buy sheet says so.
- Never call any `/internal/` route.

## 8. Definition of done

1. The app builds warning-free in Xcode 16 for iOS 17+, on device and simulator, with only the team selected.
2. Every screen in APP-SCREENS.md exists and its strings match.
3. Sign in with Apple, email sign-in, upload (HEIC and JPEG), classification, all four transformations, result save, My Photos select + save/zip, IAP purchase (sandbox), promo redeem, report, support, sign out, delete account — all exercised against the live backend with the owner's test account (he'll provide credentials; don't hard-code any).
4. Backend: three additions implemented, tested, and documented in `backend/` the same way the rest of it is; `npm test` green; deploy instructions for him in the README (he deploys with `npx wrangler deploy` — he has done it before).
5. `docs/APP-STORE.md` filled in with the listing copy and review notes, ready to paste.
6. A short `HANDBACK.md` at the project root written for the owner in plain English: what was built, what he needs to do in App Store Connect, how to run it on his phone, how to TestFlight it (same steps as his Horizon Home Media app), and anything that was ambiguous and how it was resolved.
