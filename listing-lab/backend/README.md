# Listing Lab — backend

Status: **live at https://thelistinglab.app** (custom domain since 29 Aug 2026;
the `workers.dev` address still resolves but is not the product). Accounts,
credits, Stripe Checkout, promo codes, all four transformations, the owner
board and the grading tool are all in production. Invited beta; public launch
per `LAUNCH.md`.

```bash
npm test        # 385 tests, ~80s — real SQLite + real pixels, no mocks of money
```

Day-to-day operation — deploys, container cycling, top-ups, the golden set,
secrets, incidents — is in **`OPERATIONS.md`**. Read that before touching
anything live. Pipeline history and the reasoning behind every gate is in
`pipeline/REVIEW.md`; product/owner context in `pipeline/HANDOFF.md`; the
running to-do in `TODO.md`.

| file | what it is |
|---|---|
| `src/worker.js` | the API: accounts, sessions, photos, jobs, credits, Stripe, promos, owner board, grader |
| `src/ledger.js` | append-only credit accounting; prices and packs live here and nowhere else |
| `src/stripe.js` | webhook signature + reading a payment |
| `src/auth.js` | passwords (PBKDF2), sessions, cookies, Google OAuth helpers |
| `src/store.js` | every D1 query |
| `src/index.js` | Cloudflare entry + the `PipelineContainer` Durable Object class (env plumbing into the container; the `/cycle` legacy-kill) |
| `src/grader.js`, `src/live-page.js` | the owner's grading tool and live-jobs page |
| `schema.sql` + `migrations/` | D1 tables and the changes applied to the live database |
| `container/server.js` | the pipeline behind HTTP: `/run`, `/classify`, `/health`, `/cycle` |
| `container/Dockerfile` | the image |
| `pipeline/transform.js` | the pipeline itself — one job = one invocation |
| `pipeline/compliance.js`, `scope.js`, `prompts.js` | the one judge's rulebook, the shared clutter/keeper lists, the generation prompts |
| `pipeline/framelock.js`, `pixelguard.js`, `colorlock.js`, `maskedit.js`, `regionreview.js` | the deterministic instruments and the masked path |
| `pipeline/golden-run.js` + `golden/manifest.json` | the pre-ship gate: 80 owner-graded cases |
| `wrangler.toml` | deployment config, with the reasoning for each setting |
| `web/index.html`, `web/app.html` | the marketing site and the product client |

Worker tests run against a **real SQLite database with the real `schema.sql`**, not
a hand-written fake — a fake would let every constraint pass by not existing.

## Architecture

Cloudflare **Worker + Container**.

| | runs | owns |
|---|---|---|
| **Worker** | V8 isolate | accounts, sessions, credits, history, the public API, Stripe webhooks, the owner tools |
| **Container** (`standard-1`, pool of 15 slots + 1 classify slot) | Node 22 | `transform.js` with `sharp`, two jobs per instance |

The browser talks only to the Worker. It never sees an AI vendor and never sees
an API key. `sharp` is a compiled native module and cannot run in a Worker; that
is the whole reason the container exists.

### The handoff

```
Worker  ──probe /health──▶  slot           (12s knock; sick slots are hopped and quarantined)
Worker  ──POST /run────────▶  Container     (202 immediately)
                                 │  minutes; heartbeats every 45s
                                 ▼
Worker  ◀──POST /internal/jobs/:id/result──  Container
```

Nothing holds a socket open for the length of a staging job. The browser polls.
The container never touches R2 or the database — it hands bytes back and the
Worker decides what to store and whether to return credits. Both internal routes
are guarded by `PIPELINE_SECRET`.

### The doors (who generates and who judges)

Every generation tries doors in order and falls through on a jam:

1. **fal.ai** (`FAL_FIRST` default on since 1 Sep 2026) — same `gemini-3-pro-image`
   model from fal's own capacity; direct endpoint, then fal's queue on 429/502/503.
2. **Google via Vertex** (`PROVIDER=vertex`) then the developer API.
3. Flash-class image models as a last resort.

Judging goes Google-first (`gemini-3.6-flash`) with fal's vision door
(Claude Haiku) as the outage fallback. The two prepaid accounts are deliberately
crossed so either running dry leaves the product limping rather than dead.
`GEMINI_VIA_WORKER=1` puts the old Worker proxy back if Google ever geo-blocks
container egress again.

### The quality spine (since the teardown, 2 Sep 2026)

One judge with a written rulebook, plus deterministic instruments — no stacked
critics. Per candidate: colour lock, pixel guard and the watermark verify
(arithmetic); the **frame lock** on twilight and staging (edge alignment, tuned on
the owner's graded pairs); the twilight **ugly floor**; and on masked declutter
deliveries the **region close-up review** — the same judge shown crops of exactly
the regions it edited. Every gate kills with one named reason that feeds the
retry. The golden set (`pipeline/golden-run.js`) must run before any rule change
ships.

## Payments: hosted Stripe Checkout

`POST /api/checkout` creates a hosted Checkout session and returns its URL. Hosted
rather than embedded so Apple Pay and Google Pay appear by themselves on a
supporting device.

**The browser sends a pack id, never a price.** Prices come from `CREDIT_PACKS` in
`src/ledger.js`, and the webhook re-checks the amount actually paid before
granting. The webhook records the event, answers Stripe fast, and grants in the
background (`stripe_events`).

## `src/ledger.js`

Append-only log. **The balance is never stored** — it is the sum of the entries.

Rules encoded, all Kyle's (Option A pricing, 28 Aug 2026):

- **Declutter, Empty Room, Virtual Staging = 2 credits. Twilight = 1.**
- Packs: 10 for $19.99, 30 for $56.99, 75 for $137.99. Purchased credits **never expire**.
- One job = one charge. The pipeline retries internally (up to three generation
  attempts, more on the masked declutter path) and gives up if nothing passes.
- No compliant result → **credits go back in full**. This is a credit return,
  **not** a Stripe refund: no money moves.
- Promo codes are ledger entries of type `promo`; the owner mints them on the board.

### Idempotency is the point

Every entry carries a caller-supplied `key`; re-applying a key already in the log is
a no-op. Stripe retries, Stripe's duplicate Event objects, and the several event
types one purchase emits are each handled — `creditKeyFor()` keys on the checkout
**session** id and refuses any event type but the granting one. The database
enforces the rest: `ledger_entries.key` is the primary key, with partial unique
indexes giving one debit and one credit-return per job.

## `schema.sql` and `migrations/`

`schema.sql` is the full current shape. `migrations/` holds the incremental
changes applied to the live database since it was created. **Keep them in step:**
anything added to `schema.sql` needs a numbered migration, and live D1 should be
checked with `PRAGMA table_info(...)` after applying one (see `OPERATIONS.md`).

`sessions` stores the **hash** of the cookie, never the cookie. `photos.original_key`
is never overwritten; a transformation always writes a new object.

## The container

`container/server.js` is a **thin harness**. It writes the photo to a file, runs
`node transform.js --input <file> --type <type> [--style …] [--room …]` as a
subprocess with its own `OUT_DIR`, and reads back the result. The pipeline is
the code that produced every render Kyle has graded.

Things that bit once and are documented in the code so they don't bite again:
Google geo-blocking container egress (the Worker proxy is the fallback);
`idFromName(job.id)` giving every job its own instance (jobs go to a pool of
slots instead); `node:22-slim` shipping no fonts (the watermark needs
`fonts-liberation`); container instances keeping the **old image** until they
cycle (`POST /internal/board/cycle` drains the fleet after every deploy — see
`OPERATIONS.md`); and four sick slots eating every job assigned to them (the
dispatch health probe, retry slot-hopping and quarantine).

## `web/app.html` and `web/index.html`

`app.html` is the product client: sign in → upload → choose → watch → save.
Notes that matter on a phone: no `capture` attribute on the file input (on iOS it
*locks* to the camera instead of hinting); every input is 16px so iOS does not
zoom; the progress bar eases toward 90% and waits there — it never claims to be
finished; the rejection screen says the original is untouched and frames it as
the product working; iOS gets the share sheet first and Download as a quiet link.

`index.html` is the marketing site. Its render is client-side; the only live
routes are the marketing sections — the prototype app it once carried is dead
code behind a redirect. Static assets are served **before** the sign-in gate
because the sign-in form lives in them.

## Deploying

The short version — the full runbook with verification steps is in
`OPERATIONS.md`:

```bash
npm test                          # must be green
npx wrangler deploy               # Worker + web assets + wrangler.toml config
```

Changing anything under `pipeline/` or `container/` means a new container image:
build it, push it with `npx wrangler containers push <tag>`, bump `image =` in
`wrangler.toml`, deploy, then **cycle the fleet** so no instance keeps serving
the old image. Containers require the **Workers Paid** plan.
