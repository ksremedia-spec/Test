# Listing Lab iPhone app — hand-back

Written 9 Sep 2026 for Kyle. Plain English; every "I verified" and "I'm assuming" is labelled.

## The one-paragraph version

The native iPhone app is written and sits in `ios/` (`ListingLab.xcodeproj`, SwiftUI, no third-party code). It does everything the web app does — sign in, upload, choose a fix, watch it run, see the checked result, save it, the My photos library with select mode, buy credits, promo codes, report a problem, message support — with the same words and the same decisions, plus the four native things: Sign in with Apple, credits as In-App Purchases, "Save to Camera Roll" that writes straight into Photos, and Delete my account. The three server additions those need are built, tested (424 tests green) and committed in `backend/` — **not deployed**. Nothing is live until you do the steps below.

## What I could and could not verify here

- **I verified** the backend: every new route has tests that run the real code against a real SQLite database, and the whole suite passes (`npm test` → 424 pass, 0 fail). I ran it before and after.
- **I could not compile or run the iPhone app.** The machine this was built on is Linux with no Xcode and no iPhone simulator. I wrote the Swift carefully and re-read every file for mistakes, but the first time it is compiled will be on your Mac. **Expect a handful of small compile errors on the first build** — the kind Xcode points at with a red line and a one-line fix. If you hit one you cannot fix, paste the error text back to me; it will be quick.
- **I could not download Apple's root certificate** (the network here blocks apple.com). The purchase checker is written to refuse every purchase until that certificate is in place — it fails safe, not open. One command fetches it (step 2 below).
- **Nothing was tested against the live site with a real account** — I had no credentials, and the app could not run here. Section "What to test on your phone" is the checklist.

## What you need to do, in order

### 1. The backend (about 10 minutes, from `backend/`)

```bash
npm install                                  # once, if node_modules is missing
npm test                                     # must say 424 pass
npx wrangler d1 export listinglab --remote --output backup-$(date +%F).sql
npx wrangler d1 execute listinglab --remote --file migrations/010-apple-sub.sql
npx wrangler d1 execute listinglab --remote --command "PRAGMA table_info(accounts)"   # you should see apple_sub
node scripts/fetch-apple-root.mjs            # step 2 — see below
npm test                                     # still 424
npx wrangler deploy
```

Nothing under `pipeline/` or `container/` changed, so there is no container build and no fleet cycle.

### 2. Apple's root certificate (one command, then compare one number)

`node scripts/fetch-apple-root.mjs` downloads "Apple Root CA - G3" from apple.com, prints its SHA-256 fingerprint, and writes it into `src/apple-root.js`. Open https://www.apple.com/certificateauthority/ and check the fingerprint it printed matches the one Apple lists for "Apple Root CA - G3". Then deploy. Until this is done, every in-app purchase is answered "Purchases cannot be confirmed right now — the app will try again automatically", and the app keeps the purchase unfinished, so no one's money is lost — it just cannot add credits yet.

### 3. While you test purchases (and only then)

TestFlight purchases go through Apple's **sandbox**. The server refuses sandbox purchases unless you switch it on:

```bash
npx wrangler secret put IAP_ALLOW_SANDBOX     # type: 1
```

**Before real customers can buy:** `npx wrangler secret delete IAP_ALLOW_SANDBOX`. With it on, a sandbox purchase (which costs nothing) adds real credits. Note: test with a sandbox tester account or TestFlight, not with Xcode's local "StoreKit configuration file" — the server can only accept Apple's real signatures.

### 4. Xcode (same steps as the Horizon Home Media app)

1. Open `ios/ListingLab.xcodeproj`.
2. Click the blue **ListingLab** project → the **ListingLab** target → **Signing & Capabilities** → **Team**: pick your team. Do the same for the **ListingLabTests** target.
3. Bundle identifier is `com.horizonhomemedia.listinglab`. If App Store Connect says it is taken, change it here **and** tell me — the server checks it on Apple sign-in and on purchases (`APP_BUNDLE_ID` in `backend/src/apple.js`, and the three product ids start with it).
4. Xcode will ask to add the **Sign in with Apple** capability to the App ID — say yes (or enable it on the App ID in the developer portal first).
5. **Product → Build** (⌘B). Fix any red lines (see above). Then **Product → Test** (⌘U) runs the unit tests.
6. Plug in your iPhone, press Run. Sign in with your test account.
7. TestFlight: **Product → Archive → Distribute App → TestFlight & App Store → Upload.** Add yourself as an internal tester.

### 5. App Store Connect

- **Create the app** with bundle id `com.horizonhomemedia.listinglab`, name **Listing Lab**.
- **In-App Purchases → create three consumables**, exact product ids (the server refuses anything else):

  | Reference name | Product ID | Price (USD) | Display name | Description |
  |---|---|---|---|---|
  | 10 credits | `com.horizonhomemedia.listinglab.credits10` | 19.99 | 10 credits | Credits for finished, checked listing photos. Never expire. |
  | 30 credits | `com.horizonhomemedia.listinglab.credits30` | 56.99 | 30 credits | Credits for finished, checked listing photos. Never expire. |
  | 75 credits | `com.horizonhomemedia.listinglab.credits75` | 137.99 | 75 credits | Credits for finished, checked listing photos. Never expire. |

  Each needs a review screenshot (the buy-credits sheet). No App Store Server API key is needed. Apple keeps 30%, or 15% if you enrol in the **App Store Small Business Program** — do it.
- **Sign in with Apple:** enable the capability on the App ID (Certificates, Identifiers & Profiles → your App ID → Sign in with Apple).
- **App Privacy:** the answers are in `docs/APP-STORE.md` (email, name, photos, purchase history, support messages — all "app functionality", none for tracking). The app's `PrivacyInfo.xcprivacy` says the same.
- **Listing copy, keywords, review notes:** ready to paste from `docs/APP-STORE.md`. Make a dedicated review account on the site, add credits with a promo code, and paste its login into the review notes.
- **Screenshots:** you take these on your phone from real jobs (`assets/sample-photos` are the frames to use).

### 6. One line that needs your OK before it ships

The FAQ answer "Are my photos private?" could add: *"You can also delete your account — and every photo with it — from the iPhone app, under Account."* I did not add it. Say the word and it goes in.

## What to test on your phone (the definition of done, §8.3 of the brief)

Sign in with email · Create an account · Sign in with Apple (first time, and again) · upload a HEIC from the library, a JPEG, several at once · take a photo with the camera · Browse from Files · the four fixes (staging with a style and room) · the run screen, then leave it for My photos and tap the WORKING card to come back · Save to Camera Roll · "or download the file" · the versions pills on a staging with more than one · "Stage this room" after an Empty Room · a returned job's sheet and "Run it again" / "Try Empty Room" · Select → Save N to Camera Roll and Download N as .zip · Buy credits (sandbox) · Have a promo code · Something not right with this photo? · Message support (signed in, and signed out from the sign-in screen) · Sign out · Delete my account.

## What I built, in more detail

### The app (`ios/`)

- **Project:** `ListingLab.xcodeproj`, the same format as your Lab Owner app (Xcode 16, folder-synchronised groups), iOS 17+, iPhone only, portrait, dark only. Two targets: the app and `ListingLabTests`. No packages.
- **Screens, matching `docs/APP-SCREENS.md`:** Sign in / Create an account · Start with your photos · What should we do to it? · What should we do to each? (batch) · Working on it · Cleared for delivery / Nothing passed the checks / That one did not finish · My photos (grid, viewer, returned-job sheet, select mode) · Buy credits (with the promo link) · Message support · Account (new).
- **Every string** is the web's, taken from APP-SCREENS.md, with the exceptions listed under "Assumptions" below.
- **Networking:** one `APIClient` that sends the session as a `Cookie: ll_session=…` header itself, 45-second timeout on every call, 60-second stall timeout on uploads that resets on every progress event, and any 401 sends you back to sign-in. Uploads are one at a time, HEIC is converted to JPEG on the phone at quality 0.92 with the orientation baked in and no downscale, and a HEIC renamed .jpg is caught by its bytes.
- **Polling, as the web does it:** scene 1.2 s × 15, job every 4 s, library every 6 s while anything is working, and a refresh of the list, the balance and any unsettled purchase every time the app comes back to the foreground.
- **Purchases:** StoreKit 2. The app only "finishes" a purchase after the server says the credits were added; anything unfinished is replayed on launch and on foreground, so a crash mid-purchase loses nothing.
- **Icon:** 1024×1024, the camera mark centred at 72% width on `#0F141B`, with the dark and tinted variants Xcode 16 wants. Launch screen: the mark on the same dark.
- **Unit tests:** decoding of the API shapes, HEIC→JPEG conversion (bytes sniffed, orientation baked, size kept), the retry matrix, the honest progress clock, and the purchase "finish only after the server answers" rule.

### The backend (`backend/`)

Three routes, documented in `backend/README.md` and `docs/API.md` §11, tests in `backend/test/apple-signin.test.js`, `iap.test.js`, `delete-account.test.js`:

- `POST /api/auth/apple` — verifies Apple's token with Apple's published keys, finds the account by Apple's stable id (new `apple_sub` column), refuses to merge into a password or Google account by email (same rule as Google), returns the session.
- `POST /api/iap/verify` — checks the purchase's certificate chain to Apple's root, its signature, our bundle id, Production-vs-Sandbox, and the product; then adds credits through the same ledger as Stripe, keyed on the transaction id so a replay can never credit twice.
- `DELETE /api/me` — signs the account out everywhere, deletes its photos from storage, deletes the account.
- Sign-in now tells an Apple or Google account which door to use instead of "do not match".

## Assumptions and decisions I made (and where to change them)

Everything in `docs/BRIEF.md` was followed as written. Where it was silent or wrong for a phone, I chose what matched the web app and wrote it here.

1. **Layout: three tabs** — *New photos*, *My photos*, *Account* — with the credit chip in the top bar of each. The web has a header with "My photos", the chip and "Sign out"; on a phone a tab bar is the native form of that, and the brief adds the Account screen, which is where Sign out now lives. Tab names are strings the web already uses.
2. **One word changed on the run screen:** "You can safely close this **tab** — this keeps running." reads "close the **app**" in the app. A tab does not exist on a phone. *(`ios/ListingLab/Screens/RunView.swift`)*
3. **Strings the web does not have, which I had to write** (all short, all easy to change):
   - "Saved to your camera roll." / "Saved N photos to your camera roll." after a direct save (the web's share sheet needs no confirmation; a silent direct save would leave people wondering).
   - "Take Photo" and "Browse" — the two alternatives to the library picker, named as iOS names them.
   - The delete-account confirmation: "This erases your photos, results and account details from our storage. Any credits left on the account are forfeited. It cannot be undone." — built from the privacy policy's erasure sentence.
   - "Your account has been deleted." after deletion.
   - "Credit statement", "Nothing yet." on the Account screen; "Waiting for approval — the credits will be added once the purchase is approved." for a child account's Ask-to-Buy purchase; "Listing Lab can't save to your library — allow it under Settings → Listing Lab → Photos." when Photos access is refused.
4. **Account deletion and the ledger.** The brief says to delete the account row and let the database cascade, which removes the credit ledger too. The privacy policy says "the only records we keep are the minimal purchase records we are required to retain". The Stripe receipts (`stripe_events`) do survive deletion; the credit ledger entries do not. If you would rather keep an anonymised ledger (as your owner erase tool does), that is a small server change — tell me.
5. **The purchase body field** is `signedTransaction` (the brief did not name it). It is in `docs/API.md` §11.2.
6. **Apple sign-in edge:** an address that already belongs to a *different* Apple sign-in is refused with `409 APPLE_OTHER_ACCOUNT` ("That email already belongs to a different Apple sign-in."). It should never happen in practice.
7. **Twilight** always sends `style: "Dusk"`, in the batch flow too (the web omits it in batch; the server defaults it — same result, one less inconsistency).
8. **Batch rows re-narrow** when a photo's classification arrives after the screen is drawn (the web does not, and APP-SCREENS §8.3 asks for it on iOS). A row where a fix is already chosen is left alone.
9. **Leaving the run screen stops its polling** and My photos becomes the source of truth (APP-SCREENS §8.5).
10. **The app icon** was made from `assets/icons/icon-512.png` (the mark with transparency) scaled to 737px, rather than by cutting the mark out of the 1254px source, which sits on a white plate with black corners and has white parts inside the house that a cut-out would lose. At icon sizes the difference is invisible. If you have the mark as a transparent PNG at 1024 or larger, drop it in `ios/ListingLab/Assets.xcassets/AppIcon.appiconset/` and regenerate.
11. **`IAP_TRUST_ROOT_BASE64`** is a server var that overrides the embedded Apple root. The tests use it. Leave it unset in production once the constant is filled in.
12. **Google sign-in is not offered** in the app, as decided. Someone who signed up with Google on the web and tries a password in the app sees "That email signed up with Google — sign in with Google on the website."
13. **The drop-zone sub line** uses the HTML wording ("JPEG, PNG or iPhone HEIC, up to 25MB each — pick as many as you like"), as APP-SCREENS §8.1 suggested.

## Phase 2 (not built, designed for)

- **Push notification when a job finishes.** The polling lives in two places only — `RunView.watch()` and `MyPhotosView.pollWhileWorking()` — and both just call `refreshJobs`/`GET /api/jobs/:id`. A push wake would call the same refresh; the server side needs an APNs token endpoint and a send on `finishJob`. Background app refresh (as in your Lab Owner app) is the cheaper half-step.
- iPad layout; widgets.

## Files

```
listing-lab/
  HANDBACK.md                 this file
  ios/ListingLab.xcodeproj    open this
  ios/ListingLab/             the app (Core/, Screens/, Shared/, Assets.xcassets, Fonts/, Info.plist, PrivacyInfo.xcprivacy)
  ios/ListingLabTests/        the unit tests
  backend/                    the server, with the three additions (see backend/README.md "The iOS app's three doors")
  docs/APP-STORE.md           listing copy, privacy answers, review notes — ready to paste
```
