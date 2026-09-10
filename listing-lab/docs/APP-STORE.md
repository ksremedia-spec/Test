# App Store — listing, privacy answers, review notes

Everything below is decided and ready to paste. Sections marked *(owner)* are things only Kyle can do in App Store Connect; put them in HANDBACK.md as a checklist.

## Listing

- **Name:** Listing Lab
- **Subtitle (30 chars max):** AI photo enhancement for agents
- **Category:** Photo & Video (primary), Business (secondary)
- **Age rating:** 4+
- **Promotional text:** Declutter, empty, stage and twilight your listing photos — every image checked against your original before you see it, and disclosed on the image.
- **Description:**

  Listing Lab is AI photo enhancement built for real estate. Upload a listing photo, pick what you want done, and get a finished image back in minutes.

  Four transformations, no prompt box: Declutter (personal clutter out, the room stays), Empty Room (everything movable out, the house stays), Virtual Staging (real-scale furniture in Standard, Modern, Contemporary, Coastal or Luxury — up to three versions that pass), and Twilight (a daylight exterior as a true-to-life dusk).

  Every result is inspected against your original before delivery. If it changed the house — a window, a wall, a fixture — you never see it: it is rerun or refused, and your credits come back. Every delivered image carries a small permanent disclosure, so it is safe to publish.

  Pay per image with credit packs. No subscription. Credits never expire.

  Built by a working real-estate photographer and former licensed agent.

- **Keywords (100 chars):** virtual staging,real estate,listing photos,declutter,twilight,MLS,property,photo editor,agent
- **Support URL:** https://thelistinglab.app/faq
- **Marketing URL:** https://thelistinglab.app
- **Privacy Policy URL:** https://thelistinglab.app/privacy
- **Copyright:** © 2026 Horizon Home Media
- **Screenshots** *(owner)*: 6.7" and 6.1" sets. Suggested order: result slider (twilight), My Photos grid, pick screen with offers, staging versions, buy credits. Use real Horizon Home Media frames from `assets/sample-photos` — never a mockup. The app's dark UI on a plain dark background, no device frames needed.

## App Privacy (the "nutrition label") — answers

Data collected, all linked to the user, none used for tracking:

| Data | Purpose | Notes |
|---|---|---|
| Email address | App functionality (account) | Sign in with Apple may give a relay address |
| Name | App functionality | Optional, from Sign in with Apple or sign-up |
| Photos | App functionality | Uploaded to our server to produce the result; stored under the account; deletable by account deletion |
| Purchase history | App functionality | Credit purchases made on the website through Stripe, shown in the app's credit statement |
| Customer support messages | App functionality | If they message support |

Not collected: location, contacts, identifiers for advertising, usage analytics, crash data (no third-party SDKs).

`PrivacyInfo.xcprivacy`: `NSPrivacyTracking = false`; collected data types as above; required-reason API usage: `UserDefaults` (CA92.1) if used, file timestamp (C617.1) if used. Add only what the code actually uses.

## Permissions (Info.plist strings)

- `NSPhotoLibraryAddUsageDescription`: "Listing Lab saves your finished photos to your library."
- `NSPhotoLibraryUsageDescription` is NOT needed — use PHPicker (no library permission) for choosing photos.
- `NSCameraUsageDescription`: "Take a photo of the room to enhance it."

## Buying credits *(decided 10 Sep 2026 — no In-App Purchases)*

Credits are bought on the website through the existing Stripe Checkout, opened from the app in Safari and returning to it. Nothing to create in App Store Connect. The buy path is shown only on the United States storefront; elsewhere the app shows the packs with "Credits can be bought at thelistinglab.app". Since the Epic v. Apple injunction, US apps may link out to pay on the web; no entitlement is needed and Apple takes no commission on those purchases.

## Sign in with Apple *(owner)*

Enable the "Sign in with Apple" capability on the App ID in the developer portal. Nothing else server-side is needed for the identity-token flow the app uses.

## Review notes (paste into App Review Information)

> Listing Lab enhances real-estate listing photos. To test: sign in with the demo account below, tap "Add photos", choose any interior photo, pick a transformation, and wait one to three minutes (staging a few minutes longer). Results are inspected against the original before delivery and refused if they change the property; refused jobs return credits automatically. Every delivered image carries a small "Virtually …" disclosure on the image by design — this is a compliance feature for MLS use, not a watermark to remove.
>
> Credits are purchased on our website through Stripe Checkout, opened from the app in Safari and returning to the app afterwards (United States storefront only; elsewhere the app shows where to buy and no link). The demo account is pre-loaded with credits, so no purchase is needed to test. Account deletion is under Account → Delete my account.
>
> Demo account: (owner supplies) — email / password.

*(owner)*: create a dedicated review account on the site, add credits to it with a promo code (mint one on the promos board), and paste its login above. Don't use a personal account.

## Things reviewers commonly flag — already handled by the brief

- Guideline 3.1.1 / 3.1.3 (purchases): credits are bought on the website through Stripe, opened from the app — permitted for US apps since the Epic v. Apple injunction; no entitlement, no commission. The link-out is shown only on the US storefront. The app's copy never mentions Apple, the App Store or in-app purchase.
- Guideline 4.8 (Sign in with Apple when third-party sign-in offered): the app offers Google sign-in (added 10 Sep 2026) and so must, and does, offer Sign in with Apple alongside it.
- Guideline 5.1.1(v) (account deletion): in-app deletion is built.
- Guideline 2.1 (completeness): demo account with credits; nothing behind an invite.
- Privacy manifest present; no tracking.
