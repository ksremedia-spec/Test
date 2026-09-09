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
| Purchase history | App functionality | Credit purchases (in-app purchase transaction ids kept for idempotency) |
| Customer support messages | App functionality | If they message support |

Not collected: location, contacts, identifiers for advertising, usage analytics, crash data (no third-party SDKs).

`PrivacyInfo.xcprivacy`: `NSPrivacyTracking = false`; collected data types as above; required-reason API usage: `UserDefaults` (CA92.1) if used, file timestamp (C617.1) if used. Add only what the code actually uses.

## Permissions (Info.plist strings)

- `NSPhotoLibraryAddUsageDescription`: "Listing Lab saves your finished photos to your library."
- `NSPhotoLibraryUsageDescription` is NOT needed — use PHPicker (no library permission) for choosing photos.
- `NSCameraUsageDescription`: "Take a photo of the room to enhance it."

## In-App Purchases *(owner creates these in App Store Connect)*

Consumables:

| Reference name | Product ID | Price (USD) |
|---|---|---|
| 10 credits | com.horizonhomemedia.listinglab.credits10 | 19.99 |
| 30 credits | com.horizonhomemedia.listinglab.credits30 | 56.99 |
| 75 credits | com.horizonhomemedia.listinglab.credits75 | 137.99 |

Display names: "10 credits", "30 credits", "75 credits". Description for each: "Credits for finished, checked listing photos. Never expire." Screenshot for review: the buy-credits sheet.

Enrol in the App Store Small Business Program (15% instead of 30%).

## Sign in with Apple *(owner)*

Enable the "Sign in with Apple" capability on the App ID in the developer portal. Nothing else server-side is needed for the identity-token flow the app uses.

## Review notes (paste into App Review Information)

> Listing Lab enhances real-estate listing photos. To test: sign in with the demo account below, tap "Add photos", choose any interior photo, pick a transformation, and wait one to three minutes (staging a few minutes longer). Results are inspected against the original before delivery and refused if they change the property; refused jobs return credits automatically. Every delivered image carries a small "Virtually …" disclosure on the image by design — this is a compliance feature for MLS use, not a watermark to remove.
>
> Credits are sold as consumable in-app purchases. The demo account is pre-loaded with credits. Account deletion is under Account → Delete my account.
>
> Demo account: (owner supplies) — email / password.

*(owner)*: create a dedicated review account on the site, add credits to it with a promo code (mint one on the promos board), and paste its login above. Don't use a personal account.

## Things reviewers commonly flag — already handled by the brief

- Guideline 3.1.1 (in-app purchase for digital goods): credits are IAP on iOS; no Stripe, no links to buy on the web from inside the app.
- Guideline 4.8 (Sign in with Apple when third-party sign-in offered): Google sign-in is not offered on iOS; Sign in with Apple is.
- Guideline 5.1.1(v) (account deletion): in-app deletion is built.
- Guideline 2.1 (completeness): demo account with credits; nothing behind an invite.
- Privacy manifest present; no tracking.
