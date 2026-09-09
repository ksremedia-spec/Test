# Working on Listing Lab — read before doing anything

You are building the native iOS app for Listing Lab for its owner, Kyle Silva. This package contains everything: the brief, the API contract, the screen-by-screen spec, the full backend source, the brand assets, and a reference SwiftUI project. **Do not ask him questions.** Every decision has been made in `docs/BRIEF.md`; if something is still ambiguous, pick the option that most closely matches the existing web app (`backend/web/app.html`), write the choice down in `HANDBACK.md`, and keep going.

## Reading order

1. `docs/BRIEF.md` — what to build, every decision, the three backend additions, definition of done.
2. `docs/APP-SCREENS.md` — every screen, every string verbatim, design tokens, timings, the owner's recorded decisions.
3. `docs/API.md` — every endpoint, exact shapes, errors, polling cadence.
4. `docs/APP-STORE.md` — listing, privacy answers, review notes.
5. `assets/brand.md` — colours, fonts, logo usage.
6. `backend/README.md`, `backend/OPERATIONS.md` — how the backend is run and deployed. `backend/pipeline/HANDOFF.md` and `REVIEW.md` for how results are produced (background only; the app never touches the pipeline).
7. `reference/LabOwner-ios/` — his existing SwiftUI project, for project format and code style.

## Who you are working for

Kyle is a working real-estate photographer and former licensed agent, not a developer. His rules, learned the hard way over the last month:

- **Plain English.** When you write anything he will read (HANDBACK.md, commit messages, comments meant for him), explain in everyday terms. No jargon shorthand.
- **Label what you know.** "I verified X", "I'm assuming X", "I don't know X, here's how to find out." Never state a guess in the same voice as a checked fact. When a fact is small and checkable, check it.
- **Change what was asked and nothing else.** Raise other ideas in HANDBACK.md; don't ship them. He has been burned by unrequested "improvements" to copy he liked.
- **Do the research once, do the job once.** He hates a make-a-mistake / fix-it loop. Read the docs fully before writing code.
- **Copy is his.** Every user-facing string is in APP-SCREENS.md. Use them verbatim. Do not invent marketing copy, do not add exclamation marks, do not add emoji.
- **Nothing goes live without him.** You may run the backend tests and build the app freely. You may NOT deploy the backend (`wrangler deploy`), push to any remote, submit to App Store Connect, or change anything on thelistinglab.app. Leave the backend changes committed locally with clear instructions for him to deploy.
- **Never paste a secret anywhere.** There are none in this package. If you need one (an API key, a Stripe key, the pipeline secret), the answer is "Kyle sets it with `npx wrangler secret put NAME`" — write that in HANDBACK.md.

## Product rules that override everything

- Every delivered image carries a permanent disclosure stamp. Never crop it, never hide it, never offer a way around it.
- No free-text prompt to the image model. Closed menus only.
- Never show a rejected frame as a result.
- Offers the server didn't make are omitted, not disabled.
- Twilight is Dusk only.
- Credits never expire; purchases are non-refundable except where law requires; job credits come back automatically. Say it the way the web says it.
- Never call any `/internal/` route.

## How to work

- Build in `ios/` at the root of this package as an Xcode project named `ListingLab` (format per BRIEF §5). Put backend changes in `backend/` following the existing patterns and comment style, with tests, and keep `npm test` green.
- Commit as you go with plain-English messages. No pushing.
- Verify with the simulator and, where the simulator can't (Sign in with Apple, StoreKit sandbox, Photos), write exactly what he needs to do on his phone in HANDBACK.md.
- When done, write `HANDBACK.md` at the root: what was built, what he must do in App Store Connect and Xcode (step by step, like the "READ ME FIRST" in the reference project), how to deploy the backend changes, what you assumed, and what's left for Phase 2.
