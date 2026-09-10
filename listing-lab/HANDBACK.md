# Listing Lab iPhone app — hand-back

Written 9 Sep 2026 for Kyle; updated 10 Sep 2026 when credits moved from in-app purchase to the website's Stripe checkout. Plain English; every "I verified" and "I'm assuming" is labelled.

## The one-paragraph version

The native iPhone app is written and sits in `ios/` (`ListingLab.xcodeproj`, SwiftUI, no third-party code). It does everything the web app does — sign in, upload, choose a fix, watch it run, see the checked result, save it, the My photos library with select mode, buy credits, promo codes, report a problem, message support — with the same words and the same decisions, plus the four native things: Sign in with Apple, buying credits on the website from inside the app (Stripe, opened in Safari, returning to the app), "Save to Camera Roll" that writes straight into Photos, and Delete my account. The server additions those need are built, tested (409 tests green) and committed in `backend/` — **not deployed**. Nothing is live until you do the steps below.

## What I could and could not verify here

- **I verified** the backend: every new route has tests that run the real code against a real SQLite database, and the whole suite passes (`npm test` → 409 pass, 0 fail). I ran it before and after.
- **I could not compile or run the iPhone app.** The machine this was built on is Linux with no Xcode and no iPhone simulator. I wrote the Swift carefully and re-read every file for mistakes, but the first time it is compiled will be on your Mac. **Expect a handful of small compile errors on the first build** — the kind Xcode points at with a red line and a one-line fix. If you hit one you cannot fix, paste the error text back to me; it will be quick.
- **Nothing was tested against the live site with a real account** — I had no credentials, and the app could not run here. Section "What to test on your phone" is the checklist.

## What you need to do, in order

### 1. The backend (about 10 minutes, from `backend/`)

```bash
npm install                                  # once, if node_modules is missing
npm test                                     # must say 409 pass
npx wrangler d1 export listinglab --remote --output backup-$(date +%F).sql
npx wrangler d1 execute listinglab --remote --file migrations/010-apple-sub.sql
npx wrangler d1 execute listinglab --remote --command "PRAGMA table_info(accounts)"   # you should see apple_sub
npx wrangler deploy
curl -s "https://thelistinglab.app/purchase/return?status=success" | grep -c "Open Listing Lab"   # prints 1
```

Nothing under `pipeline/` or `container/` changed, so there is no container build and no fleet cycle. Nothing changes in Stripe: the app uses the same Checkout and the same webhook as the website; only the page Stripe returns to is different.

### 2. Buying credits — how it works now (decided 10 Sep 2026)

Credits are **not** sold through Apple. In the app, the buy-credits sheet looks like the web's (the three packs, MOST POPULAR on the 30, the promo link, "Credits never expire.") with one line above the packs: "You'll pay on our website — it opens in Safari and brings you back here." Tapping a pack opens the website's Stripe Checkout in Safari inside the app; after paying, Stripe lands on a new small page on the site (`/purchase/return`) that says "Payment received — returning you to the app…" and jumps straight back into the app. The app then re-reads the balance at 1.5 and 4.5 seconds, exactly as the web does, and says "Credits added — thank you!". The buy path shows only on the United States App Store storefront; elsewhere the packs are listed with "Credits can be bought at thelistinglab.app" and no link. Nothing in the app's copy mentions Apple, the App Store or in-app purchase.

Why this is allowed: since the Epic v. Apple injunction, US apps may link out to pay on the web; Apple's guidelines permit it, no entitlement is needed, and Apple currently takes no commission on those purchases.

### 3. Xcode (same steps as the Horizon Home Media app)

1. Open `ios/ListingLab.xcodeproj`.
2. Click the blue **ListingLab** project → the **ListingLab** target → **Signing & Capabilities** → **Team**: pick your team. Do the same for the **ListingLabTests** target.
3. Bundle identifier is `com.horizonhomemedia.listinglab`. If App Store Connect says it is taken, change it here **and** tell me — the server checks it on Apple sign-in (`APP_BUNDLE_ID` in `backend/src/apple.js`).
4. Xcode will ask to add the **Sign in with Apple** capability to the App ID — say yes (or enable it on the App ID in the developer portal first).
5. **Product → Build** (⌘B). Fix any red lines (see above). Then **Product → Test** (⌘U) runs the unit tests.
6. Plug in your iPhone, press Run. Sign in with your test account.
7. TestFlight: **Product → Archive → Distribute App → TestFlight & App Store → Upload.** Add yourself as an internal tester.

### 4. App Store Connect

- **Create the app** with bundle id `com.horizonhomemedia.listinglab`, name **Listing Lab**.
- **No In-App Purchases to create.** Credits are bought on the website (section 2).
- **Sign in with Apple:** enable the capability on the App ID (Certificates, Identifiers & Profiles → your App ID → Sign in with Apple).
- **App Privacy:** the answers are in `docs/APP-STORE.md` (email, name, photos, purchase history, support messages — all "app functionality", none for tracking). The app's `PrivacyInfo.xcprivacy` says the same.
- **Listing copy, keywords, review notes:** ready to paste from `docs/APP-STORE.md`. The review note says credits are purchased on our website via Stripe, opened from the app and returning to it, US storefront only, and that the demo account is pre-loaded with credits. Make that dedicated review account on the site, add credits with a promo code, and paste its login into the review notes.
- **Screenshots:** you take these on your phone from real jobs (`assets/sample-photos` are the frames to use).

### 5. The FAQ line (approved 10 Sep 2026)

The FAQ answer "Are my photos private?" now ends with: *"You can also delete your account — and every photo with it — from the iPhone app, under Account."* It is in `backend/web/faq.html` (the visible answer and the search-engine copy) and goes live with the deploy in step 1.

## What to test on your phone (the definition of done, §8.3 of the brief)

Sign in with email · Create an account · Sign in with Apple (first time, and again) · upload a HEIC from the library, a JPEG, several at once · take a photo with the camera · Browse from Files · the four fixes (staging with a style and room) · the run screen, then leave it for My photos and tap the WORKING card to come back · Save to Camera Roll · "or download the file" · the versions pills on a staging with more than one · "Stage this room" after an Empty Room · a returned job's sheet and "Run it again" / "Try Empty Room" · Select → Save N to Camera Roll and Download N as .zip · Buy credits (a real card, or a Stripe test card if you switch Stripe to test mode; check that Safari closes and the balance rises, and that "Check again" appears if it has not) · Have a promo code · Something not right with this photo? · Message support (signed in, and signed out from the sign-in screen) · Sign out · Delete my account.

## What I built, in more detail

### The app (`ios/`)

- **Project:** `ListingLab.xcodeproj`, the same format as your Lab Owner app (Xcode 16, folder-synchronised groups), iOS 17+, iPhone only, portrait, dark only. Two targets: the app and `ListingLabTests`. No packages.
- **Screens, matching `docs/APP-SCREENS.md`:** Sign in / Create an account · Start with your photos · What should we do to it? · What should we do to each? (batch) · Working on it · Cleared for delivery / Nothing passed the checks / That one did not finish · My photos (grid, viewer, returned-job sheet, select mode) · Buy credits (with the promo link) · Message support · Account (new).
- **Every string** is the web's, taken from APP-SCREENS.md, with the exceptions listed under "Assumptions" below.
- **Networking:** one `APIClient` that sends the session as a `Cookie: ll_session=…` header itself, 45-second timeout on every call, 60-second stall timeout on uploads that resets on every progress event, and any 401 sends you back to sign-in. Uploads are one at a time, HEIC is converted to JPEG on the phone at quality 0.92 with the orientation baked in and no downscale, and a HEIC renamed .jpg is caught by its bytes.
- **Polling, as the web does it:** scene 1.2 s × 15, job every 4 s, library every 6 s while anything is working, and a refresh of the list, the balance and any unsettled purchase every time the app comes back to the foreground.
- **Purchases:** the website's Stripe Checkout, opened in Safari from the buy sheet with `platform: "ios"`, returning through the `listinglab://` URL scheme (registered in Info.plist). The balance is re-read at 1.5 s and 4.5 s; if it has not moved the sheet stays open with "Your credits haven't shown up yet — it can take a moment." and a **Check again** button. Coming back to the app by hand refreshes the balance too. StoreKit is used only to read the storefront country.
- **Icon:** 1024×1024, the camera mark centred at 72% width on `#0F141B`, with the dark and tinted variants Xcode 16 wants. Launch screen: the mark on the same dark.
- **Unit tests:** decoding of the API shapes, HEIC→JPEG conversion (bytes sniffed, orientation baked, size kept), the retry matrix, the honest progress clock, the checkout return link and the balance-polling rule.

### The backend (`backend/`)

Documented in `backend/README.md` and `docs/API.md` §11, tests in `backend/test/apple-signin.test.js`, `delete-account.test.js`, `checkout-ios.test.js`:

- `POST /api/auth/apple` — verifies Apple's token with Apple's published keys, finds the account by Apple's stable id (new `apple_sub` column), refuses to merge into a password or Google account by email (same rule as Google), returns the session.
- `POST /api/checkout` accepts `platform: "ios"` — the same Stripe Checkout, but Stripe returns to `/purchase/return`, a new static page (`web/purchase-return.html`, in the site's design) that hands back to the app. The webhook grants credits exactly as for the web.
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
   - "Credit statement", "Nothing yet." on the Account screen; "Listing Lab can't save to your library — allow it under Settings → Listing Lab → Photos." when Photos access is refused.
   - "Your credits haven't shown up yet — it can take a moment." with the **Check again** button, when the balance has not moved 4.5 seconds after coming back from checkout. The web has no wording for this case (it toasts "Credits added — thank you!" regardless), so this is mine.
   - The sign-in error for a failed Sign in with Apple reads "That sign-in could not be verified — try again." (no "Apple" in the app's own copy). The server's two sentences that name Apple and Google — "That email signed up with Apple — use Sign in with Apple." and "That email signed up with Google — sign in with Google on the website." — are the ones the brief specified and are shown as the server sends them.
4. **Account deletion and the ledger.** The brief says to delete the account row and let the database cascade, which removes the credit ledger too. The privacy policy says "the only records we keep are the minimal purchase records we are required to retain". The Stripe receipts (`stripe_events`) do survive deletion; the credit ledger entries do not. If you would rather keep an anonymised ledger (as your owner erase tool does), that is a small server change — tell me.
5. **Purchases changed on 10 Sep 2026** from in-app purchase to the website's Stripe checkout; §6.2 of `docs/BRIEF.md` is superseded by section 2 above. All StoreKit purchase code, receipt verification and the `/api/iap/verify` endpoint were removed.
6. **Apple sign-in edge:** an address that already belongs to a *different* Apple sign-in is refused with `409 APPLE_OTHER_ACCOUNT` ("That email already belongs to a different Apple sign-in."). It should never happen in practice.
7. **Twilight** always sends `style: "Dusk"`, in the batch flow too (the web omits it in batch; the server defaults it — same result, one less inconsistency).
8. **Batch rows re-narrow** when a photo's classification arrives after the screen is drawn (the web does not, and APP-SCREENS §8.3 asks for it on iOS). A row where a fix is already chosen is left alone.
9. **Leaving the run screen stops its polling** and My photos becomes the source of truth (APP-SCREENS §8.5).
10. **The app icon** was made from `assets/icons/icon-512.png` (the mark with transparency) scaled to 737px, rather than by cutting the mark out of the 1254px source, which sits on a white plate with black corners and has white parts inside the house that a cut-out would lose. At icon sizes the difference is invisible. If you have the mark as a transparent PNG at 1024 or larger, drop it in `ios/ListingLab/Assets.xcassets/AppIcon.appiconset/` and regenerate.
11. **A cancelled checkout** (Stripe's cancel link, or Done in Safari) shows nothing, as the web shows nothing on `?purchase=cancelled`. If Safari is closed by hand after paying, the app still checks the balance quietly and says "Credits added — thank you!" if it rose.
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
