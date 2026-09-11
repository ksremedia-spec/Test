# Listing Lab — operations runbook

Everything needed to run, deploy, watch and repair the live product. Written
3 Sep 2026 from the incidents of the launch week. **Never paste a secret value
into this file, a chat, or a commit.**

## 1. Where things are

| thing | where |
|---|---|
| Product | https://thelistinglab.app (`www` also routes; `listinglab.ksremedia.workers.dev` still resolves) |
| Owner dashboard | `/internal/board` — Live, Deliveries, Promo codes, Reports are linked from it. **Access:** open `/internal/board?s=<DIAG_SECRET>` once in a browser; it sets a 30-day owner cookie and drops the secret from the address, and from then on the clean URLs work (grader too). Keep the `?s=` link in a password manager, not in a bookmark bar. `curl ...?s=` still works for every runbook call. Rotating `DIAG_SECRET` logs every browser out. |
| Live jobs (last 24h, errors in plain English) | `/internal/board/live?s=…` |
| Slot health (dispatch probes, quarantine) | `/internal/board/slots.json?s=…` |
| Grading tool | `/internal/grade` (cookie, see above) — add `?since=YYYY-MM-DD` for one day's crop, or `?since=2026-09-04T02:20:00Z` for one batch |
| Fleet cycle (after every container deploy) | `POST /internal/board/cycle?s=…` |
| Cloudflare | Worker `listinglab`, D1 `listinglab`, R2 `listinglab-photos`, container app `listinglab-pipelinecontainer` |
| Vendors | fal.ai (prepaid — generation first door, judge fallback), Google AI Studio (prepaid — judges, twilight scoring, Google image fallback), Vertex/GCP (Google image door), Stripe, Cloudflare (Workers Paid) |

## 2. Secrets — names and homes only

| secret | lives in | used for | rotate by |
|---|---|---|---|
| `GEMINI_API_KEY` | Worker secret; `pipeline/.env` for local benches | judges, scoring, classification, Google image fallback | new key in AI Studio → `npx wrangler secret put GEMINI_API_KEY` → redeploy → delete old |
| `FAL_KEY` | Worker secret; `pipeline/.fal_key` for local benches | fal generation + fal judge door | new key at fal.ai → `wrangler secret put` → redeploy → delete old. **Roll it soon: it was pasted in chat during the launch week.** |
| `VERTEX_API_KEY` | Worker secret | Google image door via Vertex (`PROVIDER=vertex`) | GCP console |
| `PIPELINE_SECRET` | Worker secret | guards `/run` callbacks and `/internal/gemini` | `wrangler secret put`, redeploy (containers pick it up on cycle) |
| `DIAG_SECRET` | Worker secret | every `/internal/board*` and `/internal/grade*` URL | `wrangler secret put`; all bookmarks change |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Worker secrets | checkout + webhook signature | Stripe dashboard → `wrangler secret put` |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Worker secrets | Google sign-in | Google Cloud console |
| `CLOUDFLARE_API_TOKEN` | deploy machine's `backend/.env` (gitignored) | `wrangler` from a shell | Cloudflare dashboard |

`npx wrangler secret list` shows what is set without showing values.

## 3. Deploying

### Worker only (API, web pages, wrangler.toml vars)

```bash
cd backend
npm test                                  # 385 green or stop
node scripts/prerender-landing.mjs        # ONLY if web/index.html changed — bakes the landing copy into the HTML
npx wrangler deploy                       # ~10s; assets + Worker
```

Verify: the deploy output lists the version id; `curl -s https://thelistinglab.app/api/packs` answers;
`curl -s https://thelistinglab.app/ | grep -c "AI enhancement built for"` is at least 2 (the pre-rendered copy is present).

**The landing page is pre-rendered (4 Sep 2026).** `web/index.html` used to be an empty `<div id="app">` filled by
script — 54 characters of visible text without JavaScript, so search engines and link previews saw a blank page.
`scripts/prerender-landing.mjs` runs the page's own `renderMarketing()` in headless Chromium and writes the markup
between `<!--ssr:start-->` and `<!--ssr:end-->`; the page script keeps that markup on first paint (`data-ssr`) and
only wires behaviour. The 23 photographs that were embedded as base64 (2.6 MB of a 2.8 MB file) now live in
`web/img/site/` as real files; the HTML is ~160 KB. Edit the copy in the render functions, re-run the script,
deploy. The script is idempotent.

### Container (anything under `pipeline/` or `container/`)

Instances keep serving the **old image until they are cycled**. Every container
deploy is four steps, and skipping the last one means debugging code that is
not running.

```bash
# 1. build — pick a NEW tag every time (old tags are immutable in the registry)
docker build -f container/Dockerfile -t listinglab-pipeline:<tag> .
#    (from the launch sandbox the build used /tmp/Dockerfile.deploy, which
#     mounts that sandbox's TLS CA for npm — a normal machine uses the
#     Dockerfile above as-is)

# 2. push
npx wrangler containers push listinglab-pipeline:<tag>
#    → prints "Pushed image: registry.cloudflare.com/…/listinglab-pipeline:<tag>"

# 3. point wrangler.toml at it and deploy
#    image = "registry.cloudflare.com/3555e81671c92dbf94b1a7218828d65d/listinglab-pipeline:<tag>"
npx wrangler deploy
#    → the diff must show "+ image = …:<tag>"

# 4. cycle the fleet
curl -s -X POST "https://thelistinglab.app/internal/board/cycle?s=$DIAG_SECRET"
#    → expect 16/16 slots at status 200. Each drains (finishes running jobs,
#      refuses new ones, exits when idle); an instance too old to know /cycle
#      is destroyed outright by the Durable Object.
```

Verify: `npx wrangler containers list` shows state `ready`; run one cheap job
(a twilight) end to end; `/internal/board/slots.json` shows the slot it landed
on with `last_ok_at` set.

**Rollback:** set `image =` back to the previous tag, `npx wrangler deploy`, cycle.

### Database changes

1. Edit `schema.sql` **and** add `migrations/NNN-name.sql` with the same change.
2. `npx wrangler d1 execute listinglab --remote --file migrations/NNN-name.sql`
3. Confirm: `npx wrangler d1 execute listinglab --remote --command "PRAGMA table_info(jobs)"`.
4. `npm test` (the tests load `schema.sql` into real SQLite).

**Backup:** `npx wrangler d1 export listinglab --remote --output backup-$(date +%F).sql`
— do this before any migration and on a schedule; the credit ledger lives only
in D1.

## 4. Watching it

- **Live page** every morning during beta: red rows are the ones to read.
- **`slots.json`**: `quarantined: 1` means a slot failed two probes in a row and
  is benched for 10 minutes; dispatch hops past it automatically. Persistent
  quarantines after a deploy → cycle the fleet again.
- **Board metrics**: `aiCost` is the metered spend (fal calls are estimates at
  fal's list price — fal returns no billing data; the fal dashboard is truth).
- **Budget alert**: the board's spend watch fires against `budgetUsd` in the
  `settings` table — set to **100** ($/month) on 3 Sep 2026. Change it with
  `UPDATE settings SET value='150' WHERE key='budgetUsd'`.
- `outage_retries` on a job counts vendor parks **and** our own queue waits and
  stall reclaims. It is not a pure vendor-outage counter.

## 5. Money in the tanks

Both AI accounts are **prepaid**. Symptoms of an empty tank:

| tank | symptom | check | fix |
|---|---|---|---|
| Google AI Studio | judge calls answer `429 RESOURCE_EXHAUSTED "prepayment credits are depleted"`; golden runs fail; live jobs limp on the fal judge door | `curl` a tiny `generateContent` with the key | top up at https://ai.studio/projects |
| fal | generation falls through to Google doors; fal dashboard balance near zero | fal dashboard | top up; turn on fal auto-top-up |

A rough burn guide from launch week: ~$0.15–1.50 per delivered job depending
on transformation and retries; judge traffic a few dollars a day under heavy
testing. Because the doors are crossed (fal generates first, Google judges
first), one empty tank degrades the product; only both empty stop it.

## 6. The golden set — the pre-ship gate

`pipeline/golden/manifest.json` holds 91 owner-graded cases (original +
candidate + expected pass/fail). **Run it before shipping any rule, prompt or
instrument change**, and read the misses, not just the score.

```bash
cd backend/pipeline
export $(grep GEMINI_API_KEY .env)
node golden-run.js                    # all cases, ~10 min, a few dollars of judging
node golden-run.js --type declutter   # one transformation
node golden-run.js --ids c212,c214    # specific cases
```

Reading the output: `false rejects` are good photos the system would refuse
(costs retries); `false accepts` are bad photos it would deliver (costs trust).
The known, accepted misses are annotated in the manifest notes — six k-living
orientation cases, two old-era tripwires, and the wobblers c023/c028/c223/c225
(borderline frames that flip between runs; each note says why). Two votes per case means a
borderline case can flip between runs; a change is real when it moves the same
case the same way twice.

Adding cases: copy original and candidate into `golden/images/`, append to the
manifest with `expected`, a note saying who graded it and why, and
`gradedBy: "kyle"`. The owner's grades from the in-app grader are the source of
new cases — a delivered job he fails is a false accept, a rejected one he passes
is a false reject.

## 7. Grading

`/internal/grade?s=…&since=YYYY-MM-DD` shows each job's before/after, hides the
system's verdict until a swipe, and saves each verdict to the `grades` table
instantly (nothing to copy back). Score the system against the grades with a
D1 query joining `jobs` and `grades` on status vs verdict.

## 8. Promo codes and support

- Mint codes on `/internal/board/promos`; they are ledger entries when redeemed.
- Support messages post to the owner's inbox via Cloudflare Email Routing;
  the in-app box works without signing in on purpose.
- **Erasing a customer's data** (the privacy policy promises it within 30 days
  of a request). One call, no undo — the email must be typed twice:

  ```bash
  curl -s -X POST "https://thelistinglab.app/internal/board/erase-account?s=$DIAG_SECRET" \
    -H 'content-type: application/json' \
    -d '{"email":"agent@example.com","confirm":"agent@example.com"}'
  # → {"ok":true,"photos":N,"jobs":N,"objectsDeleted":N,"objectsFailed":0}
  ```

  It deletes every original, result and variant from R2, every photo, job,
  attempt, grade, report and session from D1, and anonymises the account row
  (`erased+<id>@deleted.invalid`). Ledger entries and Stripe events stay — the
  purchase records the policy names as the exception — and the address is free
  to sign up again afterwards. `objectsFailed` above zero means R2 refused a
  delete: rerun the call; it is safe to repeat.

## 9. Incident quick reference

| symptom | likely cause | do |
|---|---|---|
| Jobs die only on certain slots; retries die too | a wedged instance on an old image ("poisoned slot") | `slots.json` → cycle the fleet; probes and hopping now contain this automatically |
| Everything on `queued`, nothing starts | pool jammed or `max_instances` hit | `wrangler containers list`; cycle; check `JOB_POOL_SIZE` (15) |
| Jobs fail with `pipeline exited null` | container process killed — usually memory on very large originals | note the source size; rerun; downscale guard if it repeats |
| Bursts of `500 high demand` / `503` | Google's shared pool | nothing — the doors fall through; jobs park and the cron retries |
| Judges answer 429 | Google prepay empty | §5 |
| Twilight delivered with a moved camera | frame lock threshold | `FRAMELOCK_MIN` (0.42) — check the job's `framelock.score` in its audit before touching it |
| Declutter delivered with ghosting | region review missed or skipped | the job audit's `review` field; `REGION_REVIEW` must not be `0` |
| A kitchen/laundry delivered without its range, fridge, washer… | the judge's appliance check (2a/3b) missed it | add the case to the golden set; `APPLIANCE_CHECK=1` turns on the close-up roll call as a backstop |
| A job shows "working" past 15 minutes | should be impossible — the sweep's wait cutoff fails and refunds anything older, heartbeating or not | check the cron is firing (`wrangler tail` shows `wait cutoff:` lines) |
| A result comes back sideways next to an upright original | an iPhone portrait with an EXIF rotation tag reached a pre-`upright1` image | fixed 3 Sep 2026 (`pipeline/orient.js` turns every input upright first); if it recurs, check the running image tag |
| A deploy "didn't take" | old image still serving | cycle the fleet (§3) |

## 10. The tunables that matter

All read in the container from the Worker's `[vars]`/secrets (see `src/index.js`
for exactly what is plumbed). Defaults are the shipped values.

| var | default | what |
|---|---|---|
| `FAL_FIRST` | on | fal is the first generation door; `0` restores Google-first |
| `PROVIDER` | `vertex` | which Google door is tried first |
| `JUDGE_VOTES` | `2` | votes per judge call; both must pass |
| `FRAMELOCK_MIN` / `FRAMELOCK_MIN_STAGING` | `0.42` / `0.32` | camera-change gates (twilight / staging); `0` disables |
| `TWILIGHT_SCORE_FLOOR` | `5` | twilight quality below this retries |
| `REGION_REVIEW` | on | close-up review of every declutter delivery's clutter regions (classic and masked); `0` disables |
| `NOTICEABLE_MIN` | `5` | the region review's viewing-scale bar: a close-up "residue" verdict is re-rated 0–10 on an unmagnified 1024px window and only a rating at or above this stays fatal; below it the mark is a "trace" (Kyle's ruling, 4 Sep: "a mark you'd not notice" ships) |
| `CLAIM_CHECK` | on | a failing vote's "X was removed" claims are checked against the pixels, then the crops; `0` disables |
| `APPLIANCE_CHECK` | off | appliance census + close-up roll call on passing candidates; `1` enables. Off because the prompt + judge rule carry it on realistic photos (Kyle, 3 Sep) |
| `LEFTOVER_DELIVER_PCT` | `1.5` | tiny leftovers under this % of frame deliver |
| `MASKED_FIRST`, `MASKED_FIRST_MAX_PCT`, `MASKED_FIRST_MAX_REGION_PCT` | on, `25`, `8` | the coverage router: masked path leads on small jobs |
| `PIXEL_GUARD` | on | fixed-feature pixel snap |
| `TWILIGHT_EV` | `-0.25` | the twilight look's exposure, in stops, on every delivered twilight (Kyle's choice by eye, 10 Sep 2026); `0` with `TWILIGHT_CONTRAST=0` is an exact no-op |
| `TWILIGHT_CONTRAST` | `0.35` | the twilight look's contrast S-curve strength |
| `JOB_POOL_SIZE` | `15` | container slots (×2 jobs each) |
| `IMAGE_SIZE` | `2K` | render size, every job |

## 11. Browser-side hardening (3 Sep 2026)

Every request runs through the Worker (`run_worker_first = true`), which
sends `http://` and `www.` to `https://thelistinglab.app` with a 301 and stamps
every response with HSTS, `nosniff`, `X-Frame-Options: DENY`, a referrer
policy and a permissions policy. HTML pages also carry a Content Security
Policy: scripts and connections from this origin only, styles and fonts also
from Google Fonts, images from here plus `data:`/`blob:`. **Adding a third-party
script, font host or image host to a page means adding it to `PAGE_CSP` in
`src/worker.js`**, or the browser will silently refuse it — check the console
for "Refused to…" after any such change. The owner board keeps its own
stricter policy.

## 12. Source control and backups

The repository must live on a remote, not only on a working machine. Push after
every deploy; export D1 before every migration; keep `backups/` and
`pipeline/out/` out of git (they are local artefacts, ~200 MB).
