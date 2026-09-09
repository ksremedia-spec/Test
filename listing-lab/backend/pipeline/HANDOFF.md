# Listing Lab — Full Project Handoff

**Owner:** Kyle, Horizon Home Media (real-estate photography, Connecticut)
**Last updated:** 3 Sep 2026 (status section); the rest is history from 24 Aug and is kept as the record of how decisions were made
**Purpose of this doc:** everything a fresh chat needs to continue without re-asking Kyle anything.

---

## 1. What this is

**Listing Lab** is a compliance-first AI post-production studio for real-estate photography, sold under Horizon Home Media. Agents upload (or receive) listing photos and apply a small, fixed set of AI transformations. The product's entire market position is that **it refuses to ship work that misrepresents the property** — that is the differentiator, not the image quality.

Two things exist today:

| Thing | What it is | Where |
|---|---|---|
| **The pipeline** | Working Node.js prototype that actually generates and gates images. Real API calls, real money. | `listinglab-pipeline.zip` (sent in chat), unpacked at `/tmp/llp/pipeline` in the old session |
| **The artifact** | Single-file HTML prototype of the customer-facing web app + marketing site | https://claude.ai/code/artifact/787b8f5b-c71b-4ba4-9fb0-69989f1af336 |

There is also an **iOS app (v1)** in TestFlight — a SwiftUI wrapper around Kyle's Aryeo customer portal, Xcode project at `~/Desktop/iosapp/horizonhomemedia` on his Mac. Listing Lab is planned to integrate into a **v2** of that app. Web first, native second.

---

## 2. Current status (3 Sep 2026)

**In production at https://thelistinglab.app.** Cloudflare Worker + container
backend, D1 credit ledger, Stripe Checkout, Google sign-in, promo codes, all
four transformations, an owner dashboard and an in-app grading tool are live.
Invited beta of the owner plus a handful of testers; public launch per
`backend/LAUNCH.md`. Operations runbook: `backend/OPERATIONS.md`.

**Pipeline: one judge plus instruments.** The stacked-critics era ended with the
teardown of 2 Sep 2026; what stands now is one judge with a written rulebook,
deterministic instruments (colour lock, pixel guard, frame lock on twilight and
staging, the twilight quality floor, the region close-up review on masked
declutters, the appliance census + roll call on every interior job), and a
91-case owner-graded golden set as the pre-ship gate.

**Rules written 3 Sep 2026 from the soak test:** major appliances (range,
fridge, dishwasher, hood, washer, dryer…) stay in EVERY transformation, an
emptied kitchen included — `scope.APPLIANCE_RULE`, judge checks 2a/3b, golden c219;
`appliancecheck.js` (close-up roll call) exists but is OFF by default —
Kyle: the prompt + judge carry it on real photos. The masked path's assemble() now caches
its scoring (was 80s a pass on a 17-region closet; the job ran through its
own deadline into the container kill) — a packed closet now refuses honestly
in ~7–8 minutes instead of hanging 21. The Worker's 15-minute wait cutoff now
binds heartbeating jobs too.

**Rules written 4 Sep 2026 from the owner's grades on a 10-frame pro set
(3/10 right):** the judge sweeps by the catalogued CLUTTER CHECKLIST (item by
item, binding — c220 brooms, c221 cords); brooms/mops/ladders/racks/baskets/
bags/boxes/tangles of cords are never "tiny"; a loose area rug removed is
MINOR; small countertop appliances left are MINOR; the close-up review runs
on CLASSIC deliveries too and checks door/trim edges (c222); a judge's
"X was removed" claim is verified against the pixels, then the crops —
`claimcheck.js` (c223, a false reject on invented violations). Second grading
round the same night: the review must NAME a thing before calling it residue
(a sprayer nozzle and a shelf edge were refused as 'fragments' — c224, c225),
and a mark a normal viewer would not notice is 'trace', never fatal (owner's
ruling); computers/monitors/laptops in use are catalogued as KEEP, never
clutter (c226 — a delivered office lost its computers).

**The structural-only ruling (4 Sep 2026, fourth run of the same 10 frames:
7 delivered, 3 refused, owner passed all 10 — "I would deliver all 3. My
system promises no structural changes… generative AI, especially declutter
where it has to make choices like that, is never going to be perfect").**
For declutter, MAJOR is structural only: walls, windows, doors, built-ins,
cabinets, counters, floors, finishes, fixtures, appliances, window
treatments, the camera, BIG furniture gone or moved, a large piece added,
a ghost a buyer would notice, clutter clearly left. Everything else — a
lamp or pillows added, bedding restyled, a stool, side table, plastic
drawer tower or rug gone, a mark only a magnified crop reveals — is MINOR:
recorded, shipped (rules 2/4/5b in `compliance.js`; c227 lamp added, c228
kitchen with faint fridge ghost, c229 kids' bedroom with a side table
added). The region review's "residue" is no longer final at crop scale: the
accused spot is re-rated 0–10 on an UNMAGNIFIED 1024px window
(`NOTICEABLE_MIN`, default 5) — a blind full-frame sweep was tried first and
could not find even the 2 Sep "insane" ghosting unprompted, so the question
stays pointed and only the evidence changes. Wall-mounted decor with names
on it (plaques, signs, letters) is wall art, never leftover clutter.

The pipeline zip and the click-through artifact described below are the
*origins* of the product, not its current form — the code lives in
`backend/pipeline/` and the client in `backend/web/`.

## 3. Critical things to know immediately

1. **Keys have been pasted in chat during launch week** (a Gemini key in the original zip's `.env`; the fal key on 2 Sep). Rotate both — `OPERATIONS.md` §2 says how. The packaged zip now **excludes** `.env` (only `.env.example` ships). Don't put the key in notes or memory.

2. **The artifact's share link pins viewers to an earlier version.** If Kyle says "that's not what I'm seeing," this is the likely cause — he may be opening the share link, which shows a pinned older version, not the live one. Offer to re-pin.

3. **Kyle catches things.** He has personally caught: a window replaced by wall panelling, a sofa with its back to a fireplace, VSAI's smeared wall art, an over-bright colonial twilight, furniture in front of a door, and a false claim I made about his own preferences. Verify before claiming.

4. **Change what he asked for and nothing else.** He has told me off explicitly for making adjacent "improvements" he didn't request. Raise suggestions; don't ship them.

---

## 4. Environment and how to run it

### Setup
```bash
cd pipeline
npm install                       # only dependency is sharp ^0.33
cp .env.example .env              # then add GEMINI_API_KEY=...
```

Node 22. The pipeline loads `.env` itself (no `dotenv` dependency — there's a hand-rolled loader at the top of `transform.js`, copied into the test scripts).

### Commands
```bash
# the four transformations
node transform.js --input room.jpg      --type declutter
node transform.js --input room.jpg      --type empty
node transform.js --input empty.jpg     --type staging  --style Coastal --room "Living Room"
node transform.js --input house.jpg     --type twilight --style Dusk

# regression / QA
node structure-test.js                  # structural + focal gates, 13 labelled cases
node structure-test.js --only kliv-bad
node verify-artifact-photos.js --manifest /tmp/build/assets.js   # gates the demo photos
node golden-run.js                      # Kyle's 60-case graded golden set
node empty-test.js                      # empty-room control
node judge-manual.js --input x.jpg --room "Living Room" --style Standard --source vsai --candidates a.jpg,b.jpg
node bakeoff.js --rooms rooms.json      # nano vs vsai (dormant)
node source-report.js                   # per-source stats across all audits
```

### Environment variables

| Var | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | — | required |
| `JUDGE_MODEL` | `gemini-3.6-flash` | vision model for every judge/critic/checker call |
| `IMAGE_SIZE` | `2K` | `4K` is what Kyle wants for real exports (~$0.24/gen vs ~$0.134) |
| `JUDGE_VOTES` | `3` | compliance judge votes, majority decides |
| `CRITIC_VOTES` | `3` | realism critic votes |
| `FOCAL_VOTES` | `3` | focal-point gate votes |
| `STAGING_CANDIDATES` | `3` | parallel candidates per staging round |
| `STAGING_ROUNDS` | `2` | retry rounds before giving up |
| `MIN_DESIGN_SCORE` | `6` | head-stager score floor to deliver |
| `STAGING_SOURCES` | — | e.g. `nano,nano,nano` or `vsai,vsai,vsai` (bake-off only) |
| `GEMINI_TIMEOUT_MS` | `180000` | hard request timeout (see §7 — this was a real bug) |
| `TWILIGHT_TWO_PASS` | — | legacy twilight experiment |
| `VSAI_API_KEY`, `VSAI_MONTHLY` | — | dormant fallback vendor |

### Models
- **Generator:** `gemini-3-pro-image` ("Nano Banana Pro") via the **Interactions API** (`/v1beta/interactions`). ⚠️ The returned image lives at `steps[].content[]` on the `model_output` step — not where you'd guess. Getting this wrong burned three paid generations early on.
- **Judge / critic / checker:** `gemini-3.6-flash` via `generateContent`. Note `gemini-2.5-flash` is **retired** for this key (404s).

---

## 5. Pipeline architecture — file by file

```
transform.js   entry point + orchestration. Two paths:
               - staging: best-of-N candidates, gates, ranking, 2 rounds
               - declutter/empty/twilight: single attempt, up to 3 tries
gemini.js      HTTP client. Retry w/ exponential backoff on 429/5xx,
               AbortController timeout, image extraction from interactions
prompts.js     PRESERVATION header, TWILIGHT_HEADER (separate — the shared
               header's "match the original lighting" contradicts a relight),
               STAGING_STYLES, ROOM_TYPES {anchor, program, never}, emptyPrompt,
               WATERMARK_TEXT
compliance.js  RULES per transformation + CHECKS map + judgeCompliance /
               judgeComplianceVoted (3-vote majority, severity graded)
structure.js   ★ NEW — per-element structural verification + focal-point gate
critic.js      realism critic: image-diff hotspots, art/mirror/rug locator,
               native-resolution crops, 8-point checklist, shared crop set
               across votes
layout.js      door keep-clear zones in percent-of-frame coordinates
inventory.js   inventoryRoom (declutter keep-list), inventoryExterior
               (twilight structure manifest), inventoryFixed (empty-room fixed
               elements, model-classified)
brief.js       temperature-1.0 furnishing plan per job; variety decided IN CODE
               via POOLS + drawChoices(style, seed)
intent.js      client notes → closed vocabulary, code-validated; the text never
               reaches the image model
rank.js        head-stager ranking + design score
watermark.js   burns the disclosure mark, then verifies it's actually there
vsai.js        Virtual Staging AI client — DORMANT fallback, not in use
```

**Test / tooling:** `structure-test.js`, `verify-artifact-photos.js`, `golden-run.js`, `golden-apply.js`, `empty-test.js`, `judge-manual.js`, `bakeoff.js`, `mismatch-test.js`, `source-report.js`, `judge-only.js`.

**`REVIEW.md` (48 KB) is the real history** — 25 numbered rounds of what was tried, what broke, and why. Read it before changing the compliance stack.

### The staging flow, precisely

```
1. inventoryFixed / analyzeLayout   → doors, keep-clear zones, fixed features
2. locateFixed (structure.js)       → every fixed feature as a structured BOX
3. parseClientNotes (if any)        → closed vocabulary
4. newBrief × N                     → distinct furnishing plan per candidate
5. generate × 3 in parallel
6. judgeComplianceVoted (3 votes)   → pass/fail per candidate
7. ── STRUCTURAL GATE (only on candidates that passed 6) ──
   verifyFixedElements  → each feature cropped from BOTH images, asked alone
   verifyFocalPoint     → anchor orientation vs fireplace/media wall
8. critiqueRealismVoted → severe artifacts disqualify
9. rankCandidates       → head-stager score, MIN_DESIGN_SCORE floor
10. applyWatermark + verifyWatermark
11. deliver, or next round
```

Gates 7 and 8 run **only on candidates that already passed 6**, so they cost nothing on candidates that were failing anyway (~8 extra flash calls per surviving candidate).

---

## 6. The compliance stack — the actual product

### Four transformations (closed set, no prompt box, ever)

| Transformation | Credits | Watermark |
|---|---|---|
| Declutter | 1 | "Virtually Decluttered" |
| Empty Room | 1 | "Virtually Emptied" |
| Virtual Staging | 2 | "Virtually Staged" |
| Twilight | 1 | **none** — a relit sky is not a material misrepresentation |

**Staging styles:** Standard, Modern, Contemporary, Coastal, Luxury.
(Kyle renamed "Transitional" → "Standard". Older files/manifests still say Transitional.)

**Room types:** Living Room, Dining Room, Primary Bedroom, Guest Bedroom, Nursery / Kids Room, Basement / Rec Room, Home Office, Other.

**Watermark placement:** small, clean, top-left corner. Not a big badge. Cannot be disabled.

### The three AI reviewers

1. **Compliance judge** (`compliance.js`) — written rulebook per transformation, named checks, severity grading, 3-vote majority.
2. **Structural verification** (`structure.js`) — ★ the newest and most important. See below.
3. **Realism critic** (`critic.js`) — native-resolution crops of artwork, mirrors, rugs, furniture; hunts the tells (smearing, melted geometry, floating rugs, gibberish text on book spines).

### ★ Why `structure.js` exists — read this before touching the judge

On 23 Aug 2026 a staged great room passed the compliance judge **3/3 with zero violations** while having **replaced a large window with shiplap panelling and hung a painting over it.** The audit shows the judge answered the exact right question with invented evidence:

```json
"no_window_door_switch_covered": { "ok": true,
  "evidence": "window openings remain fully unobstructed by the added decor" }
```

The layout pass had even *located* the window first (`"large window with blinds, right wall, x 86-97, y 5-68"`). Rule existed, element known, question asked — and three independent votes confabulated the same answer.

**The lesson: a wide question over a wide image lets a model narrate a comparison it never performed.** Whole-image checklists are where confabulation lives.

The fix makes the question too narrow to fake:

1. Locate each fixed feature in the original as a **structured box** (never parsed out of prose — see §9 for why).
2. Crop that same box from **both** images at native resolution.
3. Lay the two crops side by side at identical scale in one image.
4. Ask about **that one feature** with a **closed answer set**.

| Verdict | Outcome |
|---|---|
| `present` | pass |
| `partly_behind_furniture` | **pass** — Kyle graded furniture in front of a window as normal |
| `covered_by_wall_mounted_object` | **fail** |
| `gone` | **fail** |
| `changed` | **fail** (different size, panes, grille, trim) |
| `unclear` | logged, no fail |

A suspected violation is **re-asked once** before it counts, so one unlucky read can't sink a good image.

### ★ The focal-point gate

Kyle: *"That one shouldn't have been checked as a pass. It doesn't properly pick the focal point."* A sofa with its back to the fireplace. This was previously MINOR-only, deferred to the design score — which has **never** caught it (his rejects score 7–9).

Now a hard gate, asked as geometry not taste: where is the focal point, which piece is the anchor, which way would someone using it be looking. `back_to_focal_point` on a majority of 3 votes fails the candidate.

**⚠️ A window is NOT a focal point.** The first version of this check failed a perfectly good Coastal living room because it nominated "large window with a view" and flagged the sofa backing onto it. Kyle explicitly graded that arrangement as fine. The gate now only fires for `fireplace`, `media_wall`, or `feature_wall`. **Do not widen this.**

`perpendicular` is not a violation — only `back_to_focal_point` is. A bed square to a side-wall TV is normal.

### Regression results

`structure-test.js` — 13 labelled cases, each declaring its expected verdict so a **false positive fails as loudly as a miss**. Currently all behave as expected, with zero false positives across ten known-good renders.

`verify-artifact-photos.js` — gates the demo photography in the artifact with the same two gates a customer job gets, non-zero exit on failure. All 13 generated demo photos pass.

---

## 7. Bugs found and fixed (don't reintroduce these)

| Bug | Fix |
|---|---|
| "No image in response" — burned 3 paid gens | Image is at `steps[].content[]` on `model_output` |
| `gemini-2.5-flash` 404 | Retired for this key; default is `gemini-3.6-flash` |
| Judge error was **fatal** after paid generation | Now a failed attempt; loop continues; unjudged output is still never delivered |
| Empty-room control failed on its own output | A keep-list **regex matched "window" inside a shelf's prose description**. Replaced with model classification. **Never classify by regex over model-written prose.** |
| Critic votes recomputed crops per vote | One shared crop set across votes |
| `sharp.extract` rejected non-integer `left` | `Math.floor` on coords |
| `buildCrops` infinite recursion | Rewrote body |
| Over-literal rules failed 5 Kyle-approved images | A sofa in front of a window whose back rises past the sill is normal; a merely soft/blurry rug is minor not severe |
| **`fetch` had no timeout** | A verification run sat on one socket for **15 minutes** with no retry. `AbortController` + `GEMINI_TIMEOUT_MS`. This could have hung a paying customer's job indefinitely. |
| Judge confabulated a window check | `structure.js` (see §6) |
| A failed image shipped anyway | `verify-artifact-photos.js` — see §9 |

---

## 8. Kyle's standards (calibration — treat as ground truth)

He personally graded a **60-case golden set** (`golden/manifest.json`, every case `gradedBy: "kyle"`, `expected` field carries pass/fail; 34 staging, 13 twilight, 9 declutter, 4 empty).

### Staging — what is FINE (do not flag)
- Outlets and floor/wall vents behind furniture
- **Covering floor vents is not a rule** — he said "delete"
- Rug edges at openings
- Frame-edge object completion
- A sofa parallel to the window wall
- A sofa/headboard in front of a window whose back rises past the sill
- Furniture in front of a baseboard heater with a visible gap

### Staging — what FAILS
- The grouping shoved against the window wall, sparse, or unbalanced ("bad placement")
- **The anchor piece with its back to the fireplace / media wall**
- Anything architectural changed, added, or covered by a wall-mounted object

### Twilight
- **Passes:** bright, crisp, pink-orange sky, lit windows — the industry lit-window convention (warm window glow, porch/landscape lights on)
- **Fails:** dark, violet, moody ("ugly output")
- The model may relight the whole scene; **only structure is locked**
- Lighting strictness matters for **interiors** (fixture on/off state must be preserved), not exteriors
- Soft residual lawn shading from daytime shadows is **acceptable** "for what we're doing and at that cost for now"
- His own real dark-window twilight look was judged too hard to reproduce at scale from daytime frames

### Training / references
- He is **OK** with showing his graded examples to the **reviewer/scorer** (calibration)
- He will **NOT** feed his staged photos as reference examples to the **generator** — believes it just copies what it sees and produces a fixed set of 3–4 looks. Quality must come from a strong prompt + a varied upstream stager agent.

---

## 9. Working with Kyle — process lessons

These are earned the hard way. Read them.

1. **Change what he asked for and nothing else.** After he approved one copy cut, I rewrote four neighbouring lines he liked and had to revert them. He was annoyed. Raise suggestions in text; let him decide.

2. **A check that runs but doesn't gate is not a check.** The structural checker caught the bad hero image, I wrote up that it caught it, I told him it caught it — and then corrected the *test's expectation* and left the failing image in the artifact. A verified-good replacement was already sitting on disk. Anything that can reject customer output must also be able to block a build. Hence `verify-artifact-photos.js`.

3. **Don't soften a mistake by pointing at mitigating context.** I noted "you're replacing this photography anyway" and he pushed back correctly: that has nothing to do with whether the mistake should have happened.

4. **Never attribute a preference to him he didn't state.** I once claimed he'd rejected VSAI over "terms you didn't want." He challenged it; I'd invented it.

5. **He evaluates with real photography, not placeholders.** "I can't get a real feel for how these things are gonna operate" from placeholder art.

6. **Verify before claiming.** Screenshot it, measure it, run the checker. He will look.

### Copy standards for the website
- Short **quick hits**, not paragraphs
- Blurbs in the same section must be **near-equal length** so they stack evenly on mobile (he noticed this specifically on mobile, not desktop)
- **Technical wording is fine** — he likes "render in parallel", "rulebook", "zoomed to full resolution"
- What he rejected as too computerized: **"the review is what takes the time"** and a line about **re-running the reference library when a rule changes**
- Keep internal mechanics out of customer-facing text, but don't generalize a single rejected line into a rewrite of its neighbours

---

## 10. Product decisions (locked unless he reopens them)

### Business model
- Listing Lab is **open to everybody** (changed Aug 2026 from clients-only). Standalone web app; the benefit to his photography business is seamless v2 app integration for his own clients.
- **Standalone from Aryeo** — own accounts, direct photo upload. Aryeo integration deferred to an optional future add-on, not a launch dependency. (Aryeo's public API has no endpoint to attach edited photos back to a listing; only their own iOS app's private upload flow does.)
- **No free monthly credits.** Previously planned 5/month per client; dropped. If he wants to give clients free credits later, the plan is a monthly promo code.
- Credits sold via **Stripe**. Listing Lab is a website in a normal browser; Kyle already has a Stripe account. Apple IAP becomes relevant only later, if and when Listing Lab is folded into the iOS app.
  > ⚠️ **Corrected 25 Aug 2026.** This line previously read "credits sold in-app via Apple IAP, eating Apple's commission." **Kyle never decided that** — an earlier session invented it, and it propagated into this handoff and into memory before he caught it. See §9.4. If a "decision" here has no trace of him saying it, distrust it.

### Credits
- One credit currency. Declutter/Empty/Twilight = 1, Staging = 2.
- **A credit buys up to 3 generation attempts** on one photo + enhancement.
- Purchased credits never expire.
- A compliance failure **restores the credit**.
- Originals are **never** overwritten.

### Pricing (placeholder, configurable)
| Pack | Price | Per credit |
|---|---|---|
| 10 | $19.99 | $2.00 |
| 30 | $54.99 | $1.83 |
| 75 | $124.99 | $1.67 |

⚠️ **He insists margin math is done on the worst case** — all 3 attempts of a credit burned (~$0.74 at 4K) — **not** the blended average. He wants exports at 4K.

### Timing
- The old "<60 seconds" promise is **dead** — the compliance and vision checks push past it. Site now says **"Minutes"**.
- Measured: ~116s for a staging job passing on the first round. A retry round adds ~60s.
- He is fine with this: *"anything under a few minutes is negligible to me."* Compliance fidelity outranks speed.

### Explicitly rejected features
- In-app re-edit requests (agents would abuse it)
- AI-narrated / stills-based video (cannibalizes his real videography service)
- AI-drafted MLS description — blocked because agents never enter bed/bath data (he charges flat rate, not by square footage, so there's no reason for them to)
- Sky replacement as a v2 differentiator — he already does it on every listing as standard
- Any prompt box, free-form editing, or masking. Ever.

### Brand
- Horizon Home Media colors: logo azure blue (~#3E79B9) + black + white
- Dark theme site-wide — *"don't like the white"*
- Admin/business dashboard is branded **"Listing Lab dashboard"**, must **not** be linked anywhere in the customer product; lives elsewhere as a separate internal tool

---

## 11. Vendor history — why Nano Banana

| Vendor | Outcome |
|---|---|
| **Decor8** | ❌ Rejected — no structure lock. *"It changes everything in the room including structural... I can't have that."* He asked for **all mention removed**. |
| **Apply Design** | ❌ Rejected — price / resale terms |
| **Virtual Staging AI** (Zillow) | ❌ Not chosen. Bake-off showed it is **generative inpainting, not compositing** (it added a ceiling light fixture). Kyle himself spotted smeared wall art and warped furniture. Terms let Zillow use uploads/outputs and terminate at will. API key requires the $79/mo plan. **His subscription can be cancelled.** `vsai.js` stays as dormant fallback code. |
| **Nano Banana Pro** | ✅ **Chosen.** *"We have way more control over it than VSAI."* |

⚠️ I once wrongly stated VSAI was "compositing." It is generative inpainting. Kyle caught it. Corrected in `REVIEW.md`.

---

## 12. The artifact — structure

**URL:** https://claude.ai/code/artifact/787b8f5b-c71b-4ba4-9fb0-69989f1af336
**Source:** `/home/claude/listinglab.html`, ~2.61 MB single file
**To update:** republish the same file path with `url` set to the above.

- Single-file HTML SPA, hash router, `localStorage` key `listinglab_state_v1`
- Fonts: Fraunces (display) + Inter (UI)
- Routes: `#/`, `#/signin`, `#/signup`, `#/forgot[/sent]`, `#/app`, `#/app/listings`, `#/app/listing/:id`, `#/app/listing/:id/photo/:pid`, `.../studio`, `.../result/:rid`, `#/app/credits`, `#/app/history`, `#/app/account`
- Auth guard on `#/app*`; `S.auth = {signedIn,name,email,company,via}`
- **"Continue with Google"** is a *simulated* OAuth handoff — deliberately **not** a page that collects Google credentials. Do not build that.

### Photography

23 real images embedded as base64 data URIs at 1200px / q72 mozjpeg (~2.5 MB total).

```
liv.day liv.coastal liv.dining liv.office
bed1.occ bed1.declut bed1.empty bed1.staged
bed2.occ bed2.declut bed2.empty bed2.staged
ext.day ext.dusk  col.day col.dusk
kliv.empty kliv.staged  kbed.empty kbed.std kbed.lux
koff.empty koff.staged
```

Key functions: `assetKey(photo,state,opts)` resolves a display state *and* the transformation that produced it (`opts.tf`); `isWatermarked()` stops the UI stacking a badge on an image that already has a burned-in one; `offeredTransforms(photo)` only offers a transformation whose result frame actually differs from the original (so an already-empty room offers Staging only).

⚠️ **Kyle is replacing all this photography** with more impressive work. The `PHOTOS` map is keyed so swapping a file is a one-line change per asset in `/tmp/build/assets.js`. **Run `verify-artifact-photos.js` on the replacements before publishing.**

### The marketing page — current copy

Seven steps, all 102–115 characters so the cards render at identical height (151px on mobile). Four across on desktop, then a centred row of three; two columns on tablet; one column below 600px.

1. **Bounded Request** — Transformation, style and room type from a closed menu. Furnishing notes are translated, never handed to the model.
2. **Room Plan** — We measure the room first: doors, windows, switches, vents and every fixed feature that must survive the edit.
3. **Generation** — Several candidates are rendered in parallel, each inside the same structural guardrails for that room.
4. **AI Compliance Review** — An AI vision model inspects the result against a written rulebook — three independent passes, majority decides.
5. **AI Realism Review** — A second vision model zooms into artwork, mirrors and rugs, hunting the flaws that give AI staging away.
6. **Disclosure** — A required disclosure watermark is applied to the finished image automatically — it cannot be turned off.
7. **Delivery** — Only an image that clears all seven gates is released. Anything else is rejected and the credit returned.

Hero stats: **4** Transformations · **100%** Checked before delivery · **Minutes** Photo in, result out

> The structural check **still runs in the pipeline** — Kyle removed it from the *displayed* steps because steps 4 and 5 read as redundant to a customer. Step 2 still promises "every fixed feature that must survive the edit," so the claim is made; the enforcement is just unnarrated.

---

## 13. Open items / backlog

**Known limitations (documented, accepted):**
- The staging **design scorer cannot reproduce Kyle's placement judgment** — his rejects still score 7–9 even with calibration examples. It is a **ranker + egregious-layout floor, not a taste guarantee**. The focal-point gate now catches the single most common failure, but the general "sparse / unbalanced / shoved against a wall" judgment is still not automated.
- The `grouping` signal (`scattered` / `against_wall` / `facing_nothing`) is recorded as **MINOR only**. Promoting it to a hard gate needs its own false-positive run first — this is the obvious next compliance improvement.
- Edge-of-frame partial objects in declutter.
- Soft residual lawn shading in twilight — accepted by Kyle.

**Never completed:**
- The blind bake-off grading sheet (`/home/claude/bakeoff-GRADE-ME.html`) — Kyle never returned picks. Moot now that Nano is chosen.

**Next build steps:**
- **Cloudflare Worker port** — the prototype needs to become a real backend: auth, credits, history, server-side watermark, `POST /transform` with `listingId/photoId/transformationType/options`. The frontend must **never** call the AI provider directly.
- Replace demo photography (Kyle's, in progress) → run `verify-artifact-photos.js`
- Rotate the Gemini API key
- Cancel the VSAI subscription
- Eventually: private admin dashboard (usage, compliance failures, revenue, costs)

**Possible future transformations** (not now): sky, lawn, pool, fireplace, seasonal.

---

## 14. Quick reference

**Source photos** (in `pipeline/`): `bedroom1.jpg`, `bedroom2.jpg` (cluttered), `living.jpg` (empty ranch LR), `exterior.jpg` (ranch day), `colonial.jpg` (colonial day), `k-living.jpg` (great room w/ fireplace), `k-bedroom.jpg` (carpeted primary), `k-office.jpg` (blue office), plus `bedroom1-emptied.jpg` / `bedroom2-emptied.jpg` (raw emptied, used as staging inputs).

**Costs:** Nano generation ~$0.134 (2K) / ~$0.24 (4K) per attempt. Flash judge calls ~$0.008 each. A staging job runs ~$1.60 worst case at 4K.

**Business numbers Kyle stated:** shot 350 listings last year; estimates ~40% of listings would use AI enhancement; agents would enhance ~5–7 images per listing, not the whole shoot; expects 10–15% YoY growth of the photography business.

**Mock listings in the artifact:** 123 Main Street, West Hartford CT · 42 Oak Street, Bristol CT · 18 Harbor View Road, Mystic CT.

**Design inspiration:** AutoHDR — but for polish, before/after treatment and simplicity only. The brand must be original.
