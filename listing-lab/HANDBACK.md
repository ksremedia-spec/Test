# Listing Lab iPhone app — hand-back

Written 9 Sep 2026 for Kyle; updated 10 Sep 2026 when credits moved from in-app purchase to the website's Stripe checkout, and again on 10 Sep 2026 when the app was first compiled on your Mac and Google sign-in was added to it (section 2b). Plain English; every "I verified" and "I'm assuming" is labelled.

## The one-paragraph version

The native iPhone app is written and sits in `ios/` (`ListingLab.xcodeproj`, SwiftUI, no third-party code). It does everything the web app does — sign in, upload, choose a fix, watch it run, see the checked result, save it, the My photos library with select mode, buy credits, promo codes, report a problem, message support — with the same words and the same decisions, plus the native things: Sign in with Apple, Face ID and push notifications (section 2c), Continue with Google (the website's own Google sign-in, shown in a sheet inside the app — section 2b), buying credits on the website from inside the app (Stripe, opened in Safari, returning to the app), "Save to Camera Roll" that writes straight into Photos, and Delete my account. The server additions those need are built, tested (419 tests green, run on your Mac on 10 Sep 2026) and **deployed** — the database changes and the website update went live from your Mac on 10 Sep 2026, with you logged in to GitHub and Cloudflare in the browser. Step 1 below is done; a backup of the database from just before the change is on your Desktop (`listinglab-backup-2026-09-09.sql`).

## What I could and could not verify here

- **I verified** the backend: every new route has tests that run the real code against a real SQLite database, and the whole suite passes (`npm test` → 409 pass, 0 fail). I ran it before and after.
- **I verified the app compiles and its unit tests pass** (10 Sep 2026, on your Mac, Xcode 26.6, iPhone 17 simulator): a clean build with no errors and no warnings, and 26 of 26 unit tests green. The app was written on a Linux machine with no Xcode; the first compile found nothing to fix. One test found a small bug in the HEIC-to-JPEG step (a file already called `.jpg` got a second `.jpg`), which is fixed.
- **I verified the server's tests** on your Mac on 10 Sep 2026 with a temporary copy of Node: `npm test` → 419 pass, 0 fail, including the 10 new Google tests in `backend/test/google-ios.test.js`.
- **I verified the deploy** from the outside afterwards: the two hand-back pages load, Google sign-in started from the app is recognised as the app's, the code exchange refuses a made-up code with the right sentence, and the FAQ line is live.
- **I verified the previews on the live site** (10 Sep 2026) with a throwaway account that I deleted afterwards: one uploaded test photo, 322 KB, came back as a 640-pixel preview of 67 KB, and the second request was served from the kept copy.
- **Nothing was tested against the live site with a real account** — I had no credentials. Section "What to test on your phone" is the checklist. The first real Continue with Google sign-in from the app is yours to do.

## What you need to do, in order

### 1. The backend — DONE 10 Sep 2026 (kept for the record, and for next time)

```bash
npm install                                  # once, if node_modules is missing
npm test                                     # should say 419 pass (409 before, plus the 10 new Google tests)
npx wrangler d1 export listinglab --remote --output backup-$(date +%F).sql
npx wrangler d1 execute listinglab --remote --file migrations/010-apple-sub.sql
npx wrangler d1 execute listinglab --remote --file migrations/011-app-signins.sql
npx wrangler d1 execute listinglab --remote --file migrations/012-devices.sql
npx wrangler d1 execute listinglab --remote --command "PRAGMA table_info(accounts)"   # you should see apple_sub
npx wrangler d1 execute listinglab --remote --command "PRAGMA table_info(app_signins)"   # you should see five columns
npx wrangler deploy
curl -s "https://thelistinglab.app/purchase/return?status=success" | grep -c "Open Listing Lab"   # prints 1
curl -s "https://thelistinglab.app/signin/return" | grep -c "Open Listing Lab"                    # prints 1
```

Nothing under `pipeline/` or `container/` changed, so there is no container build and no fleet cycle. Nothing changes in Stripe: the app uses the same Checkout and the same webhook as the website; only the page Stripe returns to is different. Nothing changes in Google either: the app uses the same sign-in client and the same callback address as the website.

### 2. Buying credits — how it works now (decided 10 Sep 2026)

Credits are **not** sold through Apple. In the app, the buy-credits sheet looks like the web's (the three packs, MOST POPULAR on the 30, the promo link, "Credits never expire.") with one line above the packs: "You'll pay on our website — it opens in Safari and brings you back here." Tapping a pack opens the website's Stripe Checkout in Safari inside the app; after paying, Stripe lands on a new small page on the site (`/purchase/return`) that says "Payment received — returning you to the app…" and jumps straight back into the app. The app then re-reads the balance at 1.5 and 4.5 seconds, exactly as the web does, and says "Credits added — thank you!". The buy path shows only on the United States App Store storefront; elsewhere the packs are listed with "Credits can be bought at thelistinglab.app" and no link. Nothing in the app's copy mentions Apple, the App Store or in-app purchase.

Why this is allowed: since the Epic v. Apple injunction, US apps may link out to pay on the web; Apple's guidelines permit it, no entitlement is needed, and Apple currently takes no commission on those purchases.

### 2b. Google sign-in in the app (added 10 Sep 2026)

You asked for Google sign-in in the app, and for it to stay in the app rather than bouncing out to Safari. Here is what was built and the one thing to know about it.

**What the person sees.** Under Sign in with Apple there is now a white **Continue with Google** button, the website's own (same words, same "G"). Tapping it slides a sheet up over the app with Google's account chooser in it. They pick their Google account, the sheet closes by itself, and they are in. If something goes wrong, the sheet closes and the red box shows the website's own sentence: "That email already has a password account — sign in with your password." when that is the case, or "Google sign-in didn't finish — try again, or use email and password." for anything else. Tapping Done on the sheet shows nothing, like closing checkout.

**The one thing to know.** Google refuses to show its sign-in page inside a page that an app draws itself (it blocks what Apple calls a web view — a policy Google enforces, not something we choose). Every legitimate Google sign-in on an iPhone, including the one in Google's own software kit, shows Google's page in a system sheet like this one. So this is as "in the app" as Google allows: no Safari app opens, no permission pop-up appears, the person never leaves Listing Lab, and the sheet is the same kind the app already uses for checkout. *I'm assuming* this is what you meant by "in app, not Safari"; if you meant something else, tell me.

**How it works underneath** (for the record; you do not need this). The app opens the website's Google sign-in with two extra words on the address: that it is the app asking, and a scrambled fingerprint of a secret the app made up a moment ago. The website sends the person to Google and back exactly as it does for the browser. At the end, instead of handing the browser a sign-in cookie, the site hands the app a one-time code on a small page (`/signin/return`, same design as the credits return page) that jumps straight back into the app. The app then sends the code and the secret to the site; the site checks the secret matches the fingerprint, throws the code away (it works once, and only for five minutes), and gives the app its session. A code that somehow leaked from the phone is useless without the secret. Nothing was changed in the Google console: same sign-in client, same callback address. The website's own Google sign-in is untouched — its tests still pass in the same file.

**One sentence of yours, shortened at your say-so (10 Sep 2026).** The server used to say "That email signed up with Google — sign in with Google." in two places: to someone who types a password for a Google account, and when a Sign in with Apple lands on a Google address. Now that the app has its own Google button, "on the website" was no longer true, so both now end at "— sign in with Google." The website shows the same shorter sentence.

**New wording, none in the app.** The button and both error sentences are the website's. The return page reuses lines from the credits return page ("Returning you to the app…", "Open Listing Lab", "You can also just switch back to the app.") with the small heading "Sign in".

### 2c. Face ID and push notifications (added 10 Sep 2026)

**Face ID.** On the Account screen there is a switch, **Unlock with Face ID** (it says Touch ID on a phone with that, and does not appear on a phone with neither set up). Off to start with. Turning it on asks for Face ID once, so the switch can never be on without working. With it on, the app locks every time it goes to the background and shows a small locked screen — the launch picture, "Listing Lab is locked", and an **Unlock with Face ID** button — with the Face ID prompt coming up by itself; your phone passcode is the fallback Apple offers inside that prompt. The setting lives on the phone only. *I verified* the switch, the lock and the unlock on the simulator with its pretend Face ID (10 Sep 2026); the first real Face ID is yours. Strings here are mine: "Unlock with Face ID", "Listing Lab is locked", "Couldn't unlock — try again.", and the prompt line "Unlock Listing Lab".

**Push notifications.** A buzz when a photo finishes. The app asks for permission the first time you start a job (the moment a notification has a point), never on the sign-in screen. The message is one line, with the app's name above it: **"Your Twilight is ready."** or **"Your Twilight came back — credits returned."** (Declutter, Empty Room, Virtual Staging or Twilight, as the website names them). Tapping it opens My photos. When the app is open in front of you nothing pops up, because the screen is already updating itself. Signing out tells the site to stop notifying that phone; deleting the account removes it. These two sentences are mine — say the word to change them.

**The one thing only you can do — the push key.** Apple lets a website send notifications only with a signing key from your developer account, and that key is a secret only you should hold. Your Horizon Home Media app already has one, and Apple's push keys work for every app on the same developer team, so Listing Lab reuses it — no trip to Apple's site. The key's id and your team id are identifiers, not secrets, and are already in place. What is left is handing the key file itself to the website, which is one line in Terminal (it reads the file straight from your Desktop, so nothing is pasted by hand):

```bash
cd ~/Desktop/iosapp/horizonhomemedia/push-relay/gameplan/Gameplan/Features/GamePlan/.claude/worktrees/sad-ishizaka-0f16e8/listing-lab/backend && PATH="$HOME/.local/listinglab-tools/node/bin:$PATH" npx wrangler secret put APNS_PRIVATE_KEY < ~/Desktop/AuthKey_7GF2569W58.p8
```

That is all — no redeploy; secrets take effect at once. Until it is done, the app and site work exactly as before and simply send nothing. The key file stays on your Desktop and is never put in the code.

*I verified* the sending code against a stand-in for Apple's service with a real signing key of the same kind (7 tests), and the routes on the live site. *I could not* send a real notification, because there is no key yet. A build you run from Xcode registers with Apple's test push service; the app knows this and tells the site, so it works for both TestFlight and Xcode builds.

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

Sign in with email · Create an account · Sign in with Apple (first time, and again) · Unlock with Face ID on, then leave the app and come back · Continue with Google (first time, again, and with an address that already has a password account — it should refuse with the password sentence; then tap Done on the sheet without choosing an account — nothing should appear) · upload a HEIC from the library, a JPEG, several at once · take a photo with the camera · Browse from Files · the four fixes (staging with a style and room) · the run screen, then leave it for My photos and tap the WORKING card to come back · Save to Camera Roll · "or download the file" · the versions pills on a staging with more than one · "Stage this room" after an Empty Room · a returned job's sheet and "Run it again" / "Try Empty Room" · Select → Save N to Camera Roll and Download N as .zip · Buy credits (a real card, or a Stripe test card if you switch Stripe to test mode; check that Safari closes and the balance rises, and that "Check again" appears if it has not) · Have a promo code · Something not right with this photo? · Message support (signed in, and signed out from the sign-in screen) · Sign out · Delete my account.

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

Documented in `backend/README.md` and `docs/API.md` §2 and §11, tests in `backend/test/apple-signin.test.js`, `google-ios.test.js`, `delete-account.test.js`, `checkout-ios.test.js`:

- `POST /api/auth/apple` — verifies Apple's token with Apple's published keys, finds the account by Apple's stable id (new `apple_sub` column), refuses to merge into a password or Google account by email (same rule as Google), returns the session.
- `GET /api/auth/google?platform=ios&challenge=…` and `POST /api/auth/google/exchange` — the app's ending to the website's Google sign-in: a one-time code on `/signin/return` (new page `web/signin-return.html`, new table `app_signins`, migration 011), swapped for a session by the app that started it. Section 2b.
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
   - The sign-in error for a failed Sign in with Apple reads "That sign-in could not be verified — try again." (no "Apple" in the app's own copy). The server's two sentences that name Apple and Google — "That email signed up with Apple — use Sign in with Apple." and "That email signed up with Google — sign in with Google." — are the ones the brief specified and are shown as the server sends them.
4. **Account deletion and the ledger.** The brief says to delete the account row and let the database cascade, which removes the credit ledger too. The privacy policy says "the only records we keep are the minimal purchase records we are required to retain". The Stripe receipts (`stripe_events`) do survive deletion; the credit ledger entries do not. If you would rather keep an anonymised ledger (as your owner erase tool does), that is a small server change — tell me.
5. **Purchases changed on 10 Sep 2026** from in-app purchase to the website's Stripe checkout; §6.2 of `docs/BRIEF.md` is superseded by section 2 above. All StoreKit purchase code, receipt verification and the `/api/iap/verify` endpoint were removed.
6. **Apple sign-in edge:** an address that already belongs to a *different* Apple sign-in is refused with `409 APPLE_OTHER_ACCOUNT` ("That email already belongs to a different Apple sign-in."). It should never happen in practice.
7. **Twilight** always sends `style: "Dusk"`, in the batch flow too (the web omits it in batch; the server defaults it — same result, one less inconsistency).
8. **Batch rows re-narrow** when a photo's classification arrives after the screen is drawn (the web does not, and APP-SCREENS §8.3 asks for it on iOS). A row where a fix is already chosen is left alone.
9. **Leaving the run screen stops its polling** and My photos becomes the source of truth (APP-SCREENS §8.5).
10. **Previews download in the background** (you asked, 10 Sep 2026, after the first phone test showed empty tiles for a while). The grid shows each finished photo at full size, shrunk down — several megabytes each — so on a phone the first row took a long time. Now the app starts downloading them quietly the moment you sign in or open the app, newest first, three at a time, and never downloads the same photo twice at once. Then, at your word the same evening, **small previews** as well: the website now makes a 640-pixel copy of each photo the first time the app asks for it (using Cloudflare's own image tool, free for the first 5,000 photos a month, so effectively free — each photo is shrunk once and the copy kept), and the grid asks for those. Old photos get theirs on first request; nothing to migrate. If the shrinking ever fails, the full photo is sent instead, so a preview problem can never hide a photo. The website itself still shows full photos in its grid, as it always did.
11. **The look, after your first phone test (10 Sep 2026):** the launch screen was a 512-pixel logo shown at full size with no sharper copies, so it filled the screen and looked blurry — it is now the mark above LISTING LAB in the website's own font, at every phone resolution, and the app's loading view shows the same picture so the hand-over is invisible. The header was iOS 26 wrapping the wordmark and the credit chip in glass capsules of its own — the app now draws the website's header bar itself (brand left, chip right, thin line under, the chip styled as the web's). My photos: the title sits on its own line with the three buttons in one row beneath, each on one line, as the website lays them out on a phone; and the photo tiles no longer push past their columns (a wide photo used to decide its card's width).
12. **The app icon** was made from `assets/icons/icon-512.png` (the mark with transparency) scaled to 737px, rather than by cutting the mark out of the 1254px source, which sits on a white plate with black corners and has white parts inside the house that a cut-out would lose. At icon sizes the difference is invisible. If you have the mark as a transparent PNG at 1024 or larger, drop it in `ios/ListingLab/Assets.xcassets/AppIcon.appiconset/` and regenerate.
13. **A cancelled checkout** (Stripe's cancel link, or Done in Safari) shows nothing, as the web shows nothing on `?purchase=cancelled`. If Safari is closed by hand after paying, the app still checks the balance quietly and says "Credits added — thank you!" if it rose.
14. **Google sign-in is in the app** (you asked for it on 10 Sep 2026, reversing the earlier decision) — section 2b. It shows only when the website says it has Google configured, as the web's button does. Someone who signed up with Google and tries a password in the app sees the server's "That email signed up with Google — sign in with Google." (shortened at your say-so, section 2b).
15. **The drop-zone sub line** uses the HTML wording ("JPEG, PNG or iPhone HEIC, up to 25MB each — pick as many as you like"), as APP-SCREENS §8.1 suggested.

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
