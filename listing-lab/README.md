# Listing Lab — native iOS app hand-off package

**For Claude Code:** open `CLAUDE.md` first, then `docs/BRIEF.md`. Everything you need is in this folder. Do not ask the owner questions — every decision is written down.

**For Kyle:** unzip this somewhere on your Mac, open the folder in Claude Code, and say: *"Read CLAUDE.md and build the iOS app as specified."* It will build in an `ios/` folder inside this package, leave the backend changes committed but not deployed, and write `HANDBACK.md` telling you exactly what to do next (App Store Connect setup, Xcode team, TestFlight, deploying the two backend additions). Nothing goes live until you do those steps yourself.

## What's in here

```
CLAUDE.md                 how to work, who it's for, the product rules that override everything
README.md                 this file
docs/
  BRIEF.md                the product, the scope of v1, every technical decision, the three backend additions, definition of done
  APP-SCREENS.md          the customer app screen by screen: every string verbatim, design tokens, timings, the owner's recorded decisions
  API.md                  every customer endpoint: shapes, errors, rate limits, polling, the recommended native flow
  APP-STORE.md            listing copy, privacy answers, IAP products, review notes
assets/
  brand.md                colours, radii, type, logo usage — the quick reference
  logo/                   logo-source-1254.png (highest-res mark; make the app icon from it), logo-full-192.png
  icons/                  the site's icon set (512, 192, 180, 32)
  fonts/                  Fraunces TTFs, weights 400–700 + italics, with the OFL licence
  sample-photos/          real listing frames and real outputs (with the disclosure stamp) — for screenshots and previews
  founder/                the owner's portrait (founder page only — not for the app UI)
  social-card.jpg         the site's link preview
backend/                  the entire production system, as deployed on 9 Sep 2026 (secrets removed)
  src/                    the Cloudflare Worker API — worker.js, store.js (D1), ledger.js (credits), auth.js, stripe.js, zip.js, owner pages
  web/                    the web app (app.html), the marketing site (index.html), FAQ, founder, terms, privacy, icons, sample images
  container/, pipeline/   the image pipeline (background reading only — the app never talks to it)
  schema.sql, migrations/ the database
  test/                   386 tests — `npm install && npm test` (needs Node 22)
  wrangler.toml           deploy config; README.md / OPERATIONS.md / LAUNCH.md / TODO.md — how it's run
reference/
  LabOwner-ios/           the owner's existing SwiftUI app (private back-office). Project format and code style to copy. Not the customer app.
ios/                      the native iPhone app, built 9 Sep 2026 — open ios/ListingLab.xcodeproj (see HANDBACK.md)
HANDBACK.md               what was built, what Kyle must do next, what was assumed
```

Not in here, on purpose: API keys and secrets (the owner sets them with `npx wrangler secret put`), the golden-set images and pipeline outputs (hundreds of MB, irrelevant to the app), `node_modules`.

## The one-paragraph version of the job

Build a native SwiftUI iPhone app for `https://thelistinglab.app` that does everything `backend/web/app.html` does — sign in, upload, classify, run one of four transformations, show the checked result, save it, manage the photo library, buy credits — with the same words and the same decisions, plus Sign in with Apple, in-app purchase for credits, direct save to the camera roll, and account deletion. Three small server additions (Apple sign-in, IAP verification, account deletion) are specified in BRIEF §6 and are part of the work. Ship-ready for TestFlight, with a plain-English hand-back for the owner.

## Live facts, checked 9 Sep 2026

- Site and API: `https://thelistinglab.app` (Cloudflare Workers + D1 + R2 + Containers).
- Packs: 10 credits $19.99 · 30 credits $56.99 · 75 credits $137.99. Declutter, Empty Room, Staging 2 credits; Twilight 1 credit.
- Typical delivery: 1–3 minutes; staging a few minutes more; server gives up and refunds at 15 minutes.
- Sessions: cookie `ll_session`, 30 days.
- Support: support@thelistinglab.app. Terms: /terms. Privacy: /privacy. FAQ: /faq. Founder: /founder.
