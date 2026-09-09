# Listing Lab — Customer App: Screens, Strings, Rules, Design

Source of truth: `web/app.html` (the shipped customer app, one file: HTML + CSS + JS), with the
marketing/legal pages `web/index.html`, `web/faq.html`, `web/terms.html`, `web/privacy.html`,
`web/founder.html`, and server rules in `src/worker.js`, `src/ledger.js`, `src/auth.js` where the
app defers to the server. Everything quoted below is verbatim from those files as of 9 Sep 2026.
Where the code is ambiguous or inconsistent it is called out in a **Unclear** note rather than guessed.

The owner is Kyle Silva (Horizon Home Media). His decisions recorded in code comments are listed in
§6 and referenced inline as "(Kyle, date)". The iOS build must honour them.

Companion document: `API.md` in this folder covers the endpoints; this file describes what the
user sees and how the client behaves.

---

## 0. Orientation

- Product name: **Listing Lab**. Wordmark in the app header: `LISTING LAB` (LAB in accent blue).
- One page app at `/app`. States are cards shown/hidden inside one `<main>`; three bottom sheets
  (Buy credits, Photo viewer, Returned-job chooser) and one Support sheet live at the end of `<body>`.
- Four transformations only, closed lists, no prompt box: *"There is no free-text box and there
  never will be — that constraint is the product."*
- The browser never sees an API key and never calls Google. It uploads a photo, starts a job,
  and polls until the job finishes. *"A staging run takes minutes, so there is no request anywhere
  in this file that waits on the pipeline."*
- Fixed dark register ("Studio Dark"). No light mode in the app. `<meta name="theme-color" content="#0C1118">`.
- Target user (from comments): *"an agent on a driveway with one bar of signal."* Every network
  decision below follows from that.

### Client state model (from `state`)

```
state = {
  account:null, balance:0,
  photo:null,            // the single-flow photo object ({photoId, url, offers, advice, signals, classifying})
  transformation:null,   // 'declutter' | 'empty' | 'twilight' | 'staging'
  jobId:null, poll:null, started:0, tick:null, waiting:false,
  batch:[],              // [{photo, file, url, fix, style, room}] while choosing   (actual objects: {photo, name, url, fix, style, room})
  queuePoll:null,        // the queue screen's own polling handle
  selecting:false, selected:new Set()   // My Photos select mode
  // also set at runtime: lastAttempts, finishedJobId, queueJobs
}
```

Note: the comment says `[{photo, file, url, fix, style, room}]` but the object actually pushed is
`{ photo: out, name: file.name, url: URL.createObjectURL(file), fix: null, style: null, room: null }` —
the file itself is not retained after upload, only its name and an object URL for the thumbnail.

### Screen order a user meets them

1. Sign in / Create an account (`#authView`)
2. Start with your photos — upload (`#uploadCard`)
3. Either "What should we do to it?" — single pick (`#pickCard`) **or** "What should we do to each?" — batch picker (`#batchCard`)
4. Working on it — run/progress (`#runCard`) (single flow only; batch goes straight to My photos)
5. Result (`#resultCard`) — "Cleared for delivery" / "Nothing passed the checks" / "That one did not finish"
6. My photos (`#queueCard`) — grid, viewer sheet, returned-job sheet, select mode
7. Sheets reachable anywhere: Buy credits, Message support
8. Header: My photos · credit chip (opens Buy credits) · Sign out

---

## 1. Screens and states, in order

### 1.1 Header bar (always present)

Sticky top bar. Left: brand link `LISTING LAB` with the 36×36 logo (`/logo-full.png`) — a plain
link to `/` (the marketing site). Comment: *"The brand is the way home — especially on a phone with
no back button in sight. Plain link, full page load: the splash page is a separate document, not a
view of this one."*

Right side (all hidden until signed in):
- `My photos` (link-style button, `#queueBtn`)
- credit chip `#creditChip` — a `<button>` with `aria-label="Buy credits"`, placeholder text `— credits`
  until the first `/api/credits` response, then `<b>N</b> credit` / `credits` (singular when N === 1).
  Tapping it opens the Buy credits sheet. It is a `<button>` because *"it is the only way to buy
  credits, and a `<div>` was unreachable by keyboard or screen reader"* (audit, 3 Sep 2026).
- `Sign out` (link-style button)

On narrow phones the wordmark wraps to LISTING over LAB; brand line-height is 1.05 so there is no
gap between the two lines (Kyle, 29 Aug).

### 1.2 Sign in / Create an account (`#authView`)

Boot: the page calls `GET /api/me`. Success → straight into the studio. Failure → show this card.

Card contents:
- Heading `Sign in` (or `Create an account` in sign-up mode)
- Sub line: `AI enhancement built for real estate.`
- Field label `EMAIL` (uppercase, letterspaced) — `type=email`, `autocomplete=email`, `inputmode=email`
- Field label `PASSWORD` — `type=password`, `autocomplete=current-password` (sign-in) / `new-password` (sign-up)
- Error box `#authErr` (hidden until an error)
- Primary button `Sign in` / `Create account`
- Google block (`#googleAuth`) — **hidden by default**; see visibility rule below:
  - divider line with the word `or`
  - white button with the Google "G" logo: `Continue with Google`
- Swap line: `No account yet?` + link `Create one`  ⇄  `Already have one?` + link `Sign in`
- Legal line (12px, faint): `By signing in or creating an account you agree to the Terms of Service and Privacy Policy. Need a hand? Message support`
  - `Terms of Service` → `/terms` (new tab), `Privacy Policy` → `/privacy` (new tab), `Message support` opens the Support sheet.

Behaviour:
- Form has `novalidate`; the only client-side check is that the button disables while the request
  is in flight. Email is `.trim()`med; password sent as typed.
- Sign-in posts `{email, password}` to `POST /api/signin`; sign-up to `POST /api/signup`. Either
  success sets `state.account` and calls `enterStudio()`.
- Any error → `#authErr` shows `err.message` from the server (or the client's network message).
- Switching modes clears the error.
- A 401 from `/api/signin`, `/api/signup` or `/api/me` is shown inline; a 401 from **any other**
  endpoint reloads the whole page (session expired / ended in another tab — *"a progress screen
  would otherwise poll a dead job forever behind a live bar"*, audit 3 Sep 2026). After reload the
  user lands on the sign-in form and My photos still holds every job.

**Google button visibility rule (verbatim comment):** *"Google sign-in: the button appears only when
the server says the OAuth client is configured, so an unconfigured deployment shows nothing broken."*
On page load the client calls `GET /api/auth/config`; if the response has `google: true` the
`#googleAuth` block is shown; on any error it stays hidden. Tapping the button navigates to
`GET /api/auth/google` (server-side OAuth redirect). The server returns 404 `Google sign-in is not
configured.` when `GOOGLE_CLIENT_ID` is unset.

Google bounce-back errors: the server redirects to `/app?auth_error=<code>`. The client strips the
query and after 400 ms shows a toast:
- code `google_password_account` → `That email already has a password account — sign in with your password.`
- any other code → `Google sign-in didn't finish — try again, or use email and password.`

**Password rules (server, `src/auth.js`):** minimum 8 characters, no other rule. Error code
`WEAK_PASSWORD` (400): `Use at least 8 characters.` There is no client-side minlength on the
shipped app. (The old prototype in index.html used placeholder `At least 8 characters` and
`minlength="8"` — see §7 note on the prototype.)

**Email rules (server):** trimmed and lower-cased; must match `^[^@\s]+@[^@\s.]+\.[^@\s]+$` and
contain none of `< > " ' \` \\`. Error `INVALID_EMAIL` (400): `Enter an email address.` (not a
string) or `That does not look like an email address.`

**Auth error texts the user can see in `#authErr`:**
- `That email and password do not match.` (401 `BAD_CREDENTIALS` — same text for unknown email and wrong password, on purpose: *"Sign-in must not reveal who has an account."*)
- `That email already has an account.` (409 `EMAIL_TAKEN`)
- `Use at least 8 characters.` (400 `WEAK_PASSWORD`)
- `That does not look like an email address.` / `Enter an email address.` (400 `INVALID_EMAIL`)
- `Too many attempts — please wait a minute and try again.` (429 `RATE_LIMITED`; sign-in/sign-up limited to 10 per minute per IP)
- `That took too long — check your signal and try again.` (client 45 s timeout)
- `Connection problem — check your signal and try again.` (client network failure)
- `Something went wrong.` (fallback when the server gave no message)

Sign out: `POST /api/signout` (errors ignored) then full page reload.

Promo deep link: if the page URL hash is `#promo` at load, `sessionStorage.promoIntent='1'` is
parked so it survives the Google round trip (Google drops the hash). See §1.9.

### 1.3 Enter the studio (`enterStudio()`)

Hides auth, shows studio, shows `creditChip`, `My photos`, `Sign out`; calls `refreshCredits()`
(`GET /api/credits` → balance and the server's cost table, which **overwrites** the client's
fallback `COSTS` — *"the server's prices win, always"*), then `resetToUpload()`.

If `#promo` / parked promo intent: strips the hash, opens the Buy credits sheet with the promo
row already expanded and focused. (*"someone arriving with a beta code in hand should land straight
on the redeem field, not have to discover the quiet link inside the buy sheet."*)

`resetToUpload()` clears `photo`, `transformation`, `jobId`, `batch`, stops the queue poll, removes
the wide layout, shows only `#uploadCard`, clears the file input. **Unclear/bug:** it does *not*
stop a running job poll (`state.poll`/`state.tick`) — see §1.6 note.

### 1.4 Upload screen (`#uploadCard`)

- Heading: `Start with your photos`
- Sub: `Pick one or several. Choose what to do with each, start them together, and put your phone away.`
- Drop zone (`role=button`, `aria-label="Choose photos"`, Enter/Space opens the picker):
  - big line: `Choose photos`
  - sub line (initial HTML): `JPEG, PNG or iPhone HEIC, up to 25MB each — pick as many as you like`
  - **Inconsistency:** after any upload attempt the drop zone is reset to the JS constant
    `DROP_IDLE`, whose sub line reads `JPEG or PNG, up to 25MB each — pick as many as you like`
    (HEIC not mentioned). iOS should use the HTML version (mentions HEIC) — flag to owner.
- `<input type=file accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple>`
  — **no `capture` attribute, deliberately**: *"on iOS it is a lock — the photo library and Files
  disappear entirely and the camera is the only option. Agents shoot a house and upload later, so
  the camera roll is the common case, not the exception. Without `capture`, iOS offers Photo
  Library, Take Photo and Browse, which is what we want."* → iOS: present the photo library
  picker (multi-select) as primary; camera and Files as alternatives.
- Error box `#uploadErr` under the drop zone.
- Desktop only: drag-and-drop with `.over` highlight.

**Multi-select and sequencing.** Files are validated then uploaded **one at a time**, on purpose:
*"Each upload runs a vision call to decide what the photo is and which fixes to offer, and a phone
on a listing's driveway is not on good wifi — five parallel uploads on 5G is how you get five
timeouts instead of five photographs. Sequential is slower on paper and finishes more often. One
bad file does not sink the batch: it is reported and the rest carry on."*

Per-file pre-checks (client), in order:
1. size > 25 MB (25·1024·1024 bytes) → bad list entry `<name> — over 25MB`
2. HEIC/HEIF (by MIME `image/heic|heif` or extension `.heic/.heif`, **or** by sniffing the bytes
   — `ftyp` at offset 4 followed by brand `heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1`) →
   converted **in the client** to JPEG (quality 0.92, EXIF orientation applied via
   `createImageBitmap`), filename `.heic/.heif` → `.jpg`. While converting the drop zone shows
   `Converting iPhone photo…` (`photos…` if more than one so far) with the filename as the sub line.
   Web has two decoders (native, then the `heic2any` library); iOS should use the platform decoder.
   Rationale (31 Aug 2026, beta finding): *"iPhones shoot HEIC by default, and files arriving
   outside iOS's own transcoding path — the Files app, AirDropped originals, a desktop with 'keep
   originals' on — were refused outright."* And: *"A HEIC renamed .jpg killed a real customer job on
   31 Aug 2026 — the name and MIME both said JPEG, so it skipped conversion."* The server and
   pipeline **only ever see JPEG/PNG**.
3. Not JPEG/PNG and not HEIC, or HEIC that could not be decoded → bad entry
   `<name> — not a photo format we can open (JPEG, PNG or iPhone HEIC)`
4. If nothing survived: drop zone resets, error `#uploadErr` = bad entries joined with `; ` (or `Nothing to upload.`).

**Per-file progress.** Upload is `POST /api/photos` with the raw bytes as the body and
`content-type` = the file's type (XHR, because fetch cannot report upload progress: *"on driveway 5G
with four photos the difference between a spinner and a moving bar is whether the person believes
anything is happening"*). The drop zone becomes:
- `Uploading N of M…` (N = 1-based index of the current file, M = number of good files)
- sub: the file name
- a 6 px progress bar (max-width 280 px) showing **cumulative bytes across the whole batch**:
  `pct = round(100 × (doneBytes + currentLoaded) / totalBytes)`, capped at 100
- `pct%` in tabular numerals

**Stall timeout.** `STALL_MS = 60000`. A timer aborts the XHR after 60 s **without any progress
event**; every progress event re-arms it, so a slow-but-moving upload is never cut off (Review, 31 Aug).
- abort → `That upload stalled — check your signal and try again.`
- network error → `Network hiccup — check your connection and try again.`
- non-2xx → server `error.message`, else `Upload failed (<status>)`
Server-side upload errors the user can see: `Upload a JPEG or PNG.` (415), `That file is empty.`
(400), `That's an iPhone HEIC photo even though it's named like a JPEG. Reload this page — iPhone
photos now convert automatically — and upload it again.` (415 — should be unreachable after client
sniffing), `That file doesn't look like a photo we can open. JPEG or PNG works best.` (415),
`That photo is over 25MB.` (413), `Attach a photo.` (400).

Per-file failures are collected as `<name> — <message>`; after the loop, if at least one photo
succeeded and some failed, `#uploadErr` shows the failures joined with `; ` and the flow continues.

**"Scanning" state (background classification).** Each successful upload returns
`{photoId, url, classifying:true, offers:[all four], advice:{}, signals:null}` immediately, and the
client starts `pollScene(photo)`: up to **15 polls at 1.2 s intervals** (≈18 s) of
`GET /api/photos/:id/scene`; when `ready` it stores `signals`, `offers`, `advice`, sets
`classifying=false`, and — **only in the single flow and only if the user has not yet picked a
transformation** — re-renders the option buttons. *"Quietly: no spinner, no flicker — the default is
every button, and the poll narrows them the instant the classifier reports. If the person has
already picked a transformation, nothing is re-rendered under their thumb; the server re-checks
scene rules at submission anyway."* (1 Sep 2026). There is **no visible "scanning" indicator**.

After the loop: thumbnails use the local file (object URL) — *"instant, one less round trip"*.
- 1 photo → single pick screen (`#pickCard`), `state.photo = batch[0].photo`
- 2+ photos → batch picker (`#batchCard`)
*"One photo keeps the original single-photo flow — the progress steps and the before/after slider
are better than a list of one."*

### 1.5 Pick / offer screen — single photo (`#pickCard`)

- Heading: `What should we do to it?`
- Sub: `Every result is checked before it reaches you. If nothing passes, your credits come back.`
- Preview image of the upload (`alt="The photo you uploaded"`)
- 2-column grid of option buttons (`.opt`, `aria-pressed`). One per **offered** transformation, in
  the order the server returns them (default order when unclassified: `declutter, empty, staging,
  twilight`). Each button:
  - line 1 (`.n`, 15px 600): the label — `Declutter` · `Empty the room` · `Virtual staging` · `Twilight`
  - line 2 (`.c`, 12.5px faint): `<cost> credit` / `credits`, and if the server sent advice for that
    transformation: ` · <advice>` (e.g. `2 credits · A very full room — Empty Room clears everything in one pass and succeeds more often on rooms like this.`)
- `STYLE` select (hidden unless staging): `Standard, Modern, Contemporary, Coastal, Luxury`
- `ROOM TYPE` select (hidden unless staging): `Living Room, Dining Room, Primary Bedroom, Guest Bedroom, Nursery / Kids Room, Basement / Rec Room, Home Office, Other`
- Error box `#startErr`
- Row: ghost `Back` (→ upload screen, discards the upload) · primary `Start` (disabled until a pick)

**Disabled/omitted options and why.** Options are not greyed — **unoffered transformations are simply
not rendered**. What is offered comes from the server's `offeredFor(signals)`
(`src/worker.js`), which *"only rules OUT the genuinely absurd — staging a room that is already
furnished, decluttering the outside of a house — and offers everything else"*:
- no signals / classifier failed / empty signals → all four
- `isExterior` → **only** `twilight`
- `removableClutter !== 'none' || furniture !== 'none'` → `declutter`; and `furniture !== 'none'` → `empty`
- `stageableFloor !== false && furniture !== 'furnished'` → `staging`
- if that yields nothing → all four (*"the classifier is more likely wrong than the photograph is useless"*)
- **`twilight` is never offered for an interior once classified** (only appears via the exterior rule or the all-four fallback).

Advice text (`adviceFor`) — *"A gentle heads-up, not a locked door"*; *"A nudge, never a block — the agent decides whether a small job is worth it"*:
- declutter, `removableClutter === 'some'`: `There is not much here to remove — expect a small change.`
- declutter, `removableClutter === 'lots'`: `A very full room — Empty Room clears everything in one pass and succeeds more often on rooms like this.` (Kyle's routing insight, 28 Aug 2026)
- staging, `furniture === 'sparse'`: `This room still has a piece or two in it. Emptying it first usually stages better.`

**Selecting (`pick(t)`):** sets `aria-pressed` on the chosen button; shows Style + Room type only for
`staging` (*"Only staging asks anything. Twilight is one look; declutter and empty have nothing to
choose."*). Start button:
- affordable (`balance >= COSTS[t]`): enabled, text `Start · <cost> credit(s)` e.g. `Start · 2 credits`, `Start · 1 credit`
- not affordable: disabled, text `Not enough credits`
There is no inline "buy" link here; the user taps the header chip.

**Credit chips:** the header chip always shows the live balance; option cards show cost per
transformation; the Start button repeats the cost.

**Start (`#startBtn`):** button shows a spinner + `Starting`; posts `POST /api/transform`
`{photoId, transformation, [style, roomType for staging], style:'Dusk' for twilight}`. Success →
`state.jobId`, balance updated on the chip, go to the run screen.
Failure handling (*"A timeout/network drop on THIS call is ambiguous: the job may have started on the
server even though the reply never arrived. So we do NOT invite a blind re-tap (which could start —
and charge — a second job). Instead we send the agent to My Photos, where the real state lives"*):
- retryable (timeout/network): `#startErr` = `<message> If it doesn't appear in My Photos in a moment, try again.`; button re-enabled as `Start`; **then My photos is opened**.
- `INSUFFICIENT_CREDITS` → `Not enough credits for that one.`
- anything else → the server's message as-is (*"NOT_APPLICABLE already reads as plain English from the server"*):
  - `This room is already furnished. Empty it first, then stage it.` (staging on a furnished room)
  - `That only applies to interior photos. Try Twilight for an exterior.`
  - `That transformation does not apply to this photo.`
  - `AI generation is temporarily paused. Your credits are safe and never expire.` (503 `GENERATION_PAUSED`, owner kill-switch)
  - `Choose a style: Standard, Modern, Contemporary, Coastal, Luxury.` / `Choose a room type: …` / `Choose a look: Dusk.` (should be unreachable)
  - `No such photo.` / `Choose a photo.` / `That is not one of the four transformations.`

### 1.6 Batch mode — "What should we do to each?" (`#batchCard`)

Shown instead of the pick card when more than one photo uploaded. *"Each row is one photograph with
its own choice of fix, because an agent working a listing has a mixed set — declutter the kitchen,
twilight the exterior, stage the empty bedroom — not four of the same thing."*

- Heading: `What should we do to each?`
- Sub: `Choose a fix per photo, then start them together. Every result is checked before it reaches you; anything that doesn't pass gives the credits back.`
- One row (`.item`) per photo: 74×56 thumbnail left; right: file name (13px faint, single line
  ellipsis), then a `<select>` (`aria-label="What to do with <name>"`) with options:
  - `Choose a fix…` (value "")
  - one per offered transformation: `<Label> · <cost> credit(s)` e.g. `Declutter · 2 credits`, `Twilight · 1 credit`
  - `Skip this one`
  - plus two hidden selects `Style` and `Room type` (same lists) that appear only when the fix is `staging`;
    choosing staging defaults style/room to the first option (`Standard`, `Living Room`).
- Error box `#batchErr`
- Row: ghost `Start over` (→ upload screen) · primary `Start`

**Which fixes appear per row:** `item.photo.offers` at render time. Because classification runs in the
background and the batch is rendered right after the last upload, rows for photos whose scene has
not yet reported show **all four**; rows whose classification finished during the sequential uploads
(the `pollScene` object is mutated in place) show the narrowed list. `pollScene` never re-renders
the batch. The server enforces the scene rule at submission, so an inapplicable pick fails that one
row with the `NOT_APPLICABLE` text above. **Unclear/wanted behaviour for iOS:** ideally re-render a
row's options when its classification arrives (the comment *"the batch screen is a different way in,
not a different rulebook"* states the intent that the same per-photo rules apply).

**Batch Start button (`updateBatchButton`)** — chosen = rows with a fix that is not empty and not `skip`:
- none chosen → disabled, `Start`
- total cost > balance → disabled, `Not enough credits · needs <cost>`; `#batchErr` = `That's <cost> credits and you have <balance>. Deselect one, or top up.` (*"Checked here as well as on the server, so an agent is told BEFORE they wait rather than watching some of a batch start and the rest bounce."*)
- otherwise enabled, `Start <n> photo(s) · <cost> credit(s)` e.g. `Start 3 photos · 5 credits`

**Batch Start action:** button → `Starting…`; jobs are submitted **one after another** (same
reason as uploads: *"a flaky connection loses one photo instead of the batch"*). Each
`POST /api/transform` `{photoId, transformation, [style, roomType]}` — note **no `style:'Dusk'` is
sent for twilight in batch**; the server defaults (only `Dusk` exists). Balance updated after the loop.
- all failed → `#batchErr` = failures `<name> — <message>` joined by `; `; button re-evaluated.
- some failed → My photos opens with the notice line `Started, but <k> could not begin: <name> — <message>; …`
- all ok → My photos opens with the default sub line.
There is **no run/progress screen for a batch** — the queue is the progress screen.

### 1.7 Run / progress screen (`#runCard`) — single flow

- Heading: `Working on it`
- Sub `#runSub` (HTML default, replaced immediately by JS): `This takes a few minutes, the vision model is working to ensure the images are correct.`
  JS sets (Kyle's wording, 28 Aug 2026 — *"Sets the expectation while they wait, so a one-version delivery reads as strict judging, not a bug. Deliberately kept OFF receipts and anything near payment."*):
  - staging: `A few minutes — we render several versions. You'll get every one that passes our checks, up to three.`
  - others: `A couple of minutes — we inspect every detail before it leaves the lab.`
- 6 px progress bar
- Step list (dot + text), per transformation (see §5 for timings). *"The interior structural pass
  never runs on an exterior, so telling an agent we are 'measuring the room — doors, windows' while
  relighting a sky is simply untrue. Every transformation, twilight included, ends with the
  disclosure (5 Sep 2026)."*

  twilight (`secs: 120`):
  1. `Reading the exterior — rooflines, windows, landscaping`
  2. `Relighting the sky`
  3. `Checking nothing about the house itself changed`
  4. `Looking for the flaws that give AI away`
  5. `Applying the disclosure`

  declutter (`secs: 150`):
  1. `Cataloguing what belongs in the room and must stay`
  2. `Clearing the clutter`
  3. `Checking every window, door and fitting survived`
  4. `Confirming the clutter is gone`
  5. `Applying the disclosure`

  empty (`secs: 150`):
  1. `Cataloguing the fixed features that must survive`
  2. `Emptying the room`
  3. `Checking every window, door and fitting survived`
  4. `Looking for the flaws that give AI away`
  5. `Applying the disclosure`

  staging (`secs: 330`):
  1. `Measuring the room — doors, windows, every fixed feature`
  2. `Rendering several furnished versions in parallel`
  3. `Checking each one against the rulebook`
  4. `Zooming in on artwork, mirrors and rugs`
  5. `Applying the disclosure to every version that passed — the pick is yours`

- Elapsed clock `m:ss` (starts `0:00`), tabular numerals, updated every second.
- Faint line: `You can safely close this tab — this keeps running.`

**Bar and steps mechanics (every 1 s tick):**
- `pct = min(90, 90 × (1 − e^(−secs / (plan.secs / 2.6))))` — *"eases toward 90% over roughly how
  long this kind of job really takes, then waits. It never claims to be finished, because we do not
  know when it will be."* Jumps to 100% only in `finish()`.
- current step `stepIdx = min(text.length − 2, floor(secs / (plan.secs / text.length)))` — steps
  before it are `done` (green dot), the current is `on` (blue dot, bright text). **The final step
  (the disclosure) is never lit by the clock**: *"That one is the victory lap — it lights only when
  the server says delivered. Otherwise a job that fails late looks like it sailed through every check
  and stumbled on the last formality, which is not what happened (Kyle, 28 Aug 2026)."*
  (In practice `finish()` swaps to the result card without lighting it; treat "delivered" as the moment it completes.)
- Sub-text overrides, checked each tick in this priority:
  1. **Waiting on Google** (`job.waitingOnUpstream` true on the last poll): `The image service is busy right now. Your photo is still queued — we keep trying, and nothing is charged unless it comes back.` — *"never as an error, because nothing has failed and nothing is charged."*
  2. `secs > plan.secs × 1.6` (twilight 192 s, declutter/empty 240 s, staging 528 s): `Still going. Some take longer than others — it will not give up early.`
- On each poll, if `job.attemptsUsed > 1` and changed: the clock and bar **restart from zero**, steps
  walk again from the top, and the sub reads `Take <n> — the last one didn't meet our bar, so it's being redone. Only a pass gets delivered.` (max 3 attempts per credit, server `ATTEMPTS_PER_CREDIT = 3`).

**Polling:** `GET /api/jobs/:jobId` every **4 s** (*"Poll gently. Nothing here is in a hurry and the
job takes minutes."*), first call immediately. `queued`/`running` → keep going. Anything else →
stop both timers, `finish(job)`. Network blips are ignored (*"A blip in the network is not a failed
job — keep polling"*). A **404** → stop and `finish({status:'failed', note:'We lost track of that job.'})`.

**The 15-minute give-up.** There is no client-side timer. The **server** fails and refunds any job
older than `GIVE_UP_AFTER_MS = 15 min` (Kyle, 31 Aug 2026, after a beta client watched "working"
for over an hour: *"Agents don't wanna wait forty minutes. If they wanted forty minutes, they
would've went with someone who did this by hand."* Normal delivery is 2–7 minutes). The client then
sees `status: 'failed'` on its next poll and shows the failure result screen with the server's
`customerMessage`: `We could not complete this within our retry window, so your credit has been
returned. Please try again shortly.` The FAQ states the promise publicly: *"If a job can't be
finished within fifteen minutes, it stops and the credits come straight back."* iOS: no local
give-up; rely on the server, keep the honest clock running.

**Return-to-My-Photos behaviour:**
- Tapping the header `My photos` while a job runs opens the queue (the run card is hidden). **Unclear/bug:** `openQueue()` does not stop the job poll, and `finish()` then shows the result card without hiding the queue card, so both can be on screen. iOS should do the clean thing: leaving the run screen stops its poll; the queue is the source of truth.
- Tapping a WORKING card in My photos → `resumeWatching(j)`: hides the queue, restores `state.jobId`,
  `transformation`, `photo`, sets the before-image to `originalUrl`, starts watching, and **rewinds the
  clock to the job's real `startedAt`** — *"a six-minute-old job opens at 6:00, not 0:00"* (Kyle, 31 Aug 2026).

### 1.8 Result screen (`#resultCard`)

Common frame: heading `#resultTitle`, sub `#resultSub`, body, action row, then the quiet AI line,
then the report link. `refreshCredits()` runs on every finish.

**Delivered (`status === 'delivered' && resultUrl`):**
- Title `Cleared for delivery`; sub `It passed every check. Drag the slider to compare.`
- Before/after slider (§ mechanics below). Before = the local preview (single flow) or `originalUrl` (resumed job).
- **Versions picker** (only when `variantUrls` non-empty; staging can deliver up to three):
  faint line `<n> versions passed our checks — keep the one you love:` and a row of pill buttons
  `Version 1`, `Version 2`, `Version 3` (`.opt` style, `aria-pressed`). Selecting one swaps the
  "after" image and retargets download/share. Default: Version 1.
- Action row: ghost `Another photo` (→ upload screen) · then **exactly one of**:
  - **Share sheet available** (`navigator.canShare && navigator.share` — iOS 15+ Safari, Android Chrome):
    primary `Save to Camera Roll` button, and Download demoted to a faint link `or download the file`
    (13px, faint colour). Rule, verbatim: *"'Save to Photos': on iPhone the ONLY road from Safari into
    the Photos app is the share sheet — a download always lands in the Files app instead. So where
    file-sharing exists (iOS 15+, Android Chrome) the share sheet is the front door and the plain
    download becomes the quiet fallback."* And (Kyle, 29 Aug): *"ONE obvious button… two equal
    buttons had people tapping Download out of habit and losing the photo to the Files app."*
    Save fetches the current version as a blob, wraps it as `listing-lab-<transformation>.jpg`
    (`image/jpeg`) and calls `navigator.share({files:[file]})`; if `canShare` refuses files it falls
    back to navigating to `<resultUrl>?download=1`. Button disabled while in flight; a dismissed
    sheet is silently ignored. **iOS native:** write directly to the Photos library (with
    permission) or present `UIActivityViewController` — the intent is "one obvious road to the camera roll".
  - **No share sheet**: ghost `Download` button only (`<a download>` to `<url>?download=1`, filename
    `listing-lab-<transformation>[-version-N].jpg`; the server sends `content-disposition: attachment`).
- **"AI can make mistakes" line** (always, on every result including failures): 
  `AI can make mistakes — please double-check before it goes live.` — 11px, line-height 1.4,
  colour `--studio-text-faint` (#6B7787) at **opacity .55**, centred, 12px above. (Kyle, 6 Sep 2026:
  *"AI can make mistakes… please double check" — one quiet line on every result, because the checker
  is good, not perfect.*)
- **Chain nudge after Empty** (Kyle, 28 Aug 2026 — *"an emptied room is a blank canvas, and the
  natural next thought is furniture"*): when `transformation === 'empty'`, a green `.note` box:
  `Now that it's empty — want to furnish it? Buyers linger longer on staged rooms.` with a small
  primary button `Stage this room`. Tapping: button → `One moment…`; `POST /api/photos/from-job
  {jobId}` makes a **server-side copy of the clean, pre-watermark result** as a new photo
  (*"feeding it the stamped delivery taught the model to redraw the stamp under the fresh one (31 Aug
  2026)"*); then the pick screen opens with that photo, `staging` pre-selected (style/room selects
  visible). Failure → toast `Could not start staging.` (or server message; e.g. `Only a delivered
  result can be used as a new starting photo.`) and the button restores.
- **Report link** (Kyle: *"make it discreet"*): faint 12.5px link `Something not right with this photo?`.
  Tapping reveals a textarea (placeholder `Tell us what looks wrong — we read every one.`, max 2000
  chars, 3 rows) and a ghost `Send` button. Empty → toast `Tell us what looks wrong first.`.
  `POST /api/report {jobId, message}` → hides the form and toasts `Thanks — we've got it and we'll take a look.`
  or, if `alreadyReported`, `We've already got your note on this one — it's in the queue.`
  Failure → toast server message or `Could not send that just now.` (Server may answer `No such photo of yours.`)

**Rejected / failed:**
- Title: rejected → `Nothing passed the checks`; failed → `That one did not finish`. Sub empty.
- Green `.note` box: `job.note` (pipeline prose, escaped) or default `Nothing compliant was produced.` (rejected) / `The run was interrupted before it could finish.` (failed).
- Bold refund line: `job.customerMessage` if present (server: rejected → `This one did not pass our
  quality and compliance checks, so your credit has been returned rather than delivering a photo we
  would not stand behind.`; failed → `We could not complete this within our retry window, so your
  credit has been returned. Please try again shortly.`), else `Your credits have been returned.`
  (rejected) / `The run was interrupted before it could finish. Your credits have been returned.` (failed).
  *"The refund is stated HERE, on the screen where the money worry lives (audit, 3 Sep 2026)."*
- Faint line: `Your original photo is untouched.` + for rejected only: ` This is the system working
  as intended — it would rather deliver nothing than deliver something that misrepresents the property.`
- **Escape hatch** (Kyle, 28 Aug 2026) — rejected **declutter** only: `.note` box `Rooms this full
  are usually beyond a tidy-up. Empty Room clears everything in one pass — and your credits are
  already back.` with primary button `Try Empty Room` → pick screen with `empty` pre-selected on the same photo.
- Download and Save hidden. Report link still shown. `Another photo` still shown.

**Before/after slider mechanics (`.ba`, `wireSlider`):**
- The **RESULT is the base layer**; the **ORIGINAL is clipped on top from the left edge**. *"so the
  left of the slider is always the original and the right is always the finished photo — the order
  every agent expects."* Tags: `ORIGINAL` top-left, `RESULT` top-right (10.5px, 700, letterspacing
  .12em, dark translucent pill `rgba(9,13,19,.72)`, text `#F2F5F9`, radius 4px).
- Handle: 2px white vertical line with a 1px dark shadow, and a 38px white round knob showing `↔` (13px 700, colour #0C1118).
- Starts at 50%. Press anywhere on the image (mouse or touch) jumps the split to that x and starts a
  drag; moves follow the pointer; `pct = clamp(0,100, (x − left)/width × 100)`; release ends.
- Drags must never select text or ghost-drag the image: `touch-action:none`, `user-select:none`,
  `-webkit-user-drag:none`, `pointer-events:none` on images (Kyle, 28 Aug 2026 "highlight-everything bug").
- The clipped original is sized to the container height on load/resize so both layers align.

### 1.9 My photos (`#queueCard`)

*"The screen that makes 'close your phone and come back' real. Jobs run on the server whether or not
anything is watching, and results are stored permanently."* Kyle's target workflow (server comment):
queue three or four images, *"close their phone, come back to it a couple minutes later, and they're all done."*

Opening (`openQueue(notice)`): hides every other card, shows the queue, adds `body.wide` (desktop
widens to 1180px; Kyle, 3 Sep: *"it's pretty skinny and tall"*), sub line = notice or default, rows
show `Loading…`, then `refreshQueue()` and the queue poll starts.

- Header row (`.qhead`): `My photos` + actions: primary small `+ Add photos` · ghost `Buy credits` ·
  ghost `Select` (shown only when **more than one** delivered job and not already selecting).
  *"The gallery's own doors: add more photos, buy more credits — at the top, where they are seen
  before the scroll, not only below fifty thumbnails."*
- Sub: `Everything you've run. Finished ones stay here — you can close the app and come back whenever.`
  (or the batch notice `Started, but N could not begin: …`)
- Empty state: `Nothing yet. Upload a photo to get started.`
- Grid (`.pgrid`): 2 columns on phone, 3 at ≥560px, 4 at ≥900px and 5 at ≥1200px when wide.
  (*"A photo product's library should look like photos, not a settings list"* — Kyle, 29 Aug.)
  The list is `GET /api/jobs` (latest 60 jobs, newest first).
- Bottom row: ghost `New photos` (→ upload screen).

**Card (`.pcard`, a `<button>`):**
- 4:3 thumbnail: `resultUrl || originalUrl` (so a working/returned card shows the original).
  Non-delivered cards are `.dim` (thumb at 40% opacity).
- Badge top-left (10.5px 700, letterspacing .05em, pill `rgba(9,13,21,.82)`):
  - `READY` — green `#5ECD96` (delivered)
  - `WORKING` — light blue `#8FBEE8` with a 6px pulsing dot before it (queued, running)
  - `RETURNED` — red `#E08A8A` (rejected, failed)
  - unknown status → its upper-cased name, red.
- Name line: the transformation label (`Declutter`, `Empty the room`, `Virtual staging`, `Twilight`).
- Sub line (11px faint):
  - delivered: `<Room type> · <Style>` (whichever exist, e.g. `Living Room · Coastal`) or `Tap to view`
  - working: `Waiting to start — tap to watch` (queued) / `Working on it — tap to watch` (running) /
    `Image service busy — nothing charged — tap to watch` (when `waitingOnUpstream`)
  - returned: `Credits returned — tap to see why`
  - while a rerun is being submitted: `Starting it again…`
- Tap: delivered → viewer sheet; working → `resumeWatching` (progress screen); returned → returned-job sheet.
  In select mode only delivered cards respond (toggle tick).

`STATE_TEXT` (used for sub lines): queued `Waiting to start`; running `Working on it`; delivered `Ready`;
rejected `Nothing passed the checks — credits returned`; failed `Did not finish — credits returned`.

**Queue polling:** every **6 s** while any job is `queued`/`running`; stops itself when nothing is
running (*"a phone left on this screen should not sit there asking every few seconds all
afternoon"*); each tick also refreshes credits. A failed `/api/jobs` call leaves the current grid
untouched (*"a blip is not an empty list"*).

**Viewer sheet (`#viewerOverlay`)** — Kyle, 29 Aug: *"the library is as capable as the moment of delivery."*
- Title: transformation label. Sub: `Drag the slider to compare.` (empty if no `originalUrl`)
- Same slider (`ORIGINAL`/`RESULT`); if no original, just the result image.
- Versions row when >1: `<n> versions passed our checks — keep the one you love:` + `Version N` pills.
- Actions: same share-vs-download rule as §1.8 (`Save to Camera Roll` full-width + `or download the file`
  link when the share sheet exists; ghost `Download` otherwise). Filenames: share `listing-lab-<transformation>.jpg`;
  download `listing-lab-<transformation>[-version-N].jpg`.
- `AI can make mistakes — please double-check before it goes live.` (same styling)
- Chain nudge for `empty` jobs (same copy, button `Stage this room`, same from-job flow; closes the sheet and the queue, opens the pick screen with staging pre-selected).
- Report link `Something not right with this photo?` → textarea (same placeholder) + `Send`;
  toasts here read `Thank you — we'll take a look.` / `Already flagged — we have it.` / `Could not send just now.`
- `Close` button; tapping the overlay backdrop also closes.

**Returned-job sheet (`#rerunOverlay`)** — Kyle, 31 Aug 2026: *"a returned card must never be a dead end that just says FAILED."*
- Title: rejected → `Nothing passed the checks`; failed → `That one did not finish`.
  (HTML default `Why this came back` is always overwritten.)
- Green `.note`: `j.note` (pipeline prose) or `No result met our compliance and realism bar, so nothing was delivered.` (rejected) / `The run was interrupted before it could finish.` (failed).
- `Your credits came back the moment it ended — this attempt cost you nothing.`
- Extra sub only for **rejected declutter**: `Rooms this full are usually beyond a tidy-up — Empty Room clears everything in one pass, same price.`
- Choice buttons (stacked, only if the job still has a `photoId`) — **exact rules**:
  - declutter, **rejected**: primary `Try Empty Room`, ghost `Run Declutter again`
  - declutter, **failed**: primary `Run Declutter again`, ghost `Try Empty Room instead`
  - any other transformation (rejected or failed): primary `Run it again`
  - no `photoId`: no buttons (only the explanation)
  Rationale: *"rejected means the checks refused every tidy-up — the room is probably beyond tidying,
  so Empty Room goes first. Failed means the run never got a fair shot (an outage, an interruption) —
  the same declutter again goes first."*
- `Not now` closes.

Rerun (`rerunJob`): `POST /api/transform` with the same `photoId`; `style`/`roomType` carried over
**only if the transformation is unchanged** (*"an Empty Room rerun of a failed declutter takes no style
or room type"*). Charge is the normal price (the failed job was already refunded). Toast
`Running it again — a fresh attempt, right here.`; failure toast = server message or `Could not start
that again just now.` Then the queue refreshes and polling restarts. Double-taps are ignored while busy.

**Select mode** (9 Sep 2026, Kyle: *"group download from the My Photos page"*):
- `Select` puts the grid in `.selecting`: every delivered card shows a 24px round tick slot top-right;
  picked cards get a blue border/inset ring and a filled blue tick `✓`; non-delivered cards are inert at 45% opacity.
- Sticky bottom bar (`.selbar`, sticks 10px + safe-area above the bottom): 
  - count: `0 selected` / `1 selected` / `N selected`
  - link `Select all` (becomes `Clear` when all delivered are picked)
  - primary `Save to Camera Roll` / `Save N to Camera Roll` (N>1) — **only when the share sheet exists**; disabled at 0
  - ghost link `Download .zip` / `Download N as .zip` (N>1) — `GET /api/jobs/zip?ids=a,b,c`; disabled (`aria-disabled`, href `#`) at 0
  - link `Cancel` (exits select mode, clears the selection)
- Save N: button → `Getting the photos…`; fetches every version of every picked job as blobs named
  `listing-lab-<NN>-<transformation>[-version-N].jpg` (NN = running 2-digit index across files), then one
  `navigator.share({files})`; if the browser refuses, falls back to the zip URL. Dismissal is silent.
- Zip: server bundles only this account's delivered jobs among the ids (max 60), names files
  `listing-lab-<NN>-<transformation>[-version-N].jpg` numbered in the order picked, archive
  `listing-lab-<stamp>.zip`. Errors: `Pick at least one photo.`, `None of those photos are ready to download.`
- A refresh recounts against the fresh list (jobs that finished after entering select mode are selectable; ids no longer delivered are dropped).
- `+ Add photos` / `New photos` exit select mode first.

### 1.10 Buy credits sheet (`#packsOverlay`)

Opened by the header chip, the `Buy credits` button in My photos, or a `#promo` deep link.
*"the server names the packs and prices (/api/packs) and hosts the actual payment (Stripe Checkout) —
this dialog never sees a card number."*

- Grab handle (phone), title `Buy credits`, sub `Credits never expire. If a photo can't be finished, its credits come back.`
- Pack buttons from `GET /api/packs` (server list, `src/ledger.js`, Kyle's "Option A", 28 Aug 2026):

  | id | credits | price | per credit | badge |
  |---|---|---|---|---|
  | `pack_10` | `10 credits` | `$19.99` | `$2.00 per credit` | — |
  | `pack_30` | `30 credits` | `$56.99` | `$1.90 per credit` | `MOST POPULAR` (client hard-codes the badge to `pack_30`) |
  | `pack_75` | `75 credits` | `$137.99` | `$1.84 per credit` | — |

  Layout: left `N credits` (16px 600) + badge, under it `$X.XX per credit` (12.5px faint); right price
  (17px 700, `--brass-soft`). Prices formatted `en-US` USD.
- Tapping a pack disables all packs and `POST /api/checkout {packId}` → navigates to Stripe's hosted
  page. Failure re-enables and toasts the message (`Could not start checkout.` fallback; server:
  `Credit sales are temporarily paused — existing credits work normally.`, `Choose one of the credit packs.`,
  `Could not start checkout. Try again in a moment.`).
- Promo: quiet link `Have a promo code?` (*"most people don't have a code and shouldn't be made to
  wonder if they're missing out on one"*) reveals an input (placeholder `e.g. LL-A1B2C3`, uppercase,
  `autocapitalize=characters`) and primary `Redeem`. `POST /api/redeem {code}` → chip updated, sheet
  closes, toast `<n> credit(s) added — enjoy!`; if a transformation was selected, affordability is
  re-checked (`pick()` re-run). Errors toast: `That code isn't one of ours — check the spelling.`,
  `You've already used that code — it's one per customer.`, `That code has expired.`,
  `That code has already been fully used.`, `Type the code first.`, fallback `That code did not work.`
- `Not now` closes; backdrop tap closes.

**Post-checkout polling.** Stripe returns to `/app?purchase=success` or `/app?purchase=cancelled`.
On `purchase=success` the client cleans the URL and, because *"the webhook can land a beat after the
redirect"*, refreshes credits at **1.5 s** and again at **4.5 s**, then toasts `Credits added — thank you!`.
On `purchase=cancelled` it only cleans the URL. (Note these fire at page load, before/alongside the
`enterStudio` credit fetch.) iOS: after the Stripe web checkout returns, poll the balance a couple of
times over ~5 s before celebrating.

### 1.11 Account / sign out

There is no account screen. The only account controls are the header `Sign out` button (→ `POST
/api/signout`, then reload) and the credit chip. Account deletion is by request through support
(privacy policy: erased within 30 days).

### 1.12 Message support sheet (`#supportOverlay`)

(Kyle, 29 Aug: *"a mailto link is a dead end on a phone with no mail app configured. This sends
through our own domain instead… Works signed out too — someone who cannot sign in needs this most."*)
- Title `Message support`; sub `Goes straight to a human. We reply by email, usually same day.`
- Email input (placeholder `Your email (so we can reply)`) — shown **only when signed out**.
- Textarea (placeholder `What can we help with?`, max 4000, 5 rows), focused on open.
- Primary `Send message` (→ `Sending…` while in flight); `Cancel`.
- Empty → toast `Write a message first.`. Success → clears, closes, toast `Sent — we'll reply by email.`
- Errors toast the server message or `Could not send — try again in a moment.` Server messages:
  `Add an email address so we can reply to you.`, `Support is briefly unavailable — email
  support@thelistinglab.app directly.`, `Could not send just now — email support@thelistinglab.app directly.`
- Opened from: the auth card legal line, and the page footer (`Terms · Privacy · Message support`).

### 1.13 Toasts (complete list)

Single fixed toast, bottom-centre (26px up), dark `#1c1d1c` on `#f2ede6` text, 14px, radius 9px,
max-width 90vw, fades after **3.2 s** (opacity transition .3s). Newer text replaces the current one.

| Trigger | Text |
|---|---|
| Google bounce, password account | `That email already has a password account — sign in with your password.` |
| Google bounce, other | `Google sign-in didn't finish — try again, or use email and password.` |
| Purchase success | `Credits added — thank you!` |
| Checkout failed | `Could not start checkout.` or server message |
| Promo redeemed | `<n> credit(s) added — enjoy!` |
| Promo failed | server message or `That code did not work.` |
| Support empty | `Write a message first.` |
| Support sent | `Sent — we'll reply by email.` |
| Support failed | server message or `Could not send — try again in a moment.` |
| Report empty (both places) | `Tell us what looks wrong first.` |
| Report sent (result screen) | `Thanks — we've got it and we'll take a look.` / `We've already got your note on this one — it's in the queue.` |
| Report failed (result screen) | server message or `Could not send that just now.` |
| Report sent (viewer) | `Thank you — we'll take a look.` / `Already flagged — we have it.` |
| Report failed (viewer) | server message or `Could not send just now.` |
| Rerun started | `Running it again — a fresh attempt, right here.` |
| Rerun failed | server message or `Could not start that again just now.` |
| Stage-this-room failed | server message or `Could not start staging.` |
| Buy sheet failed to open | server message (from `/api/packs`) |

---

## 2. Every user-facing string, verbatim, by screen

Placeholders in `<angle brackets>` are runtime values. Pluralisation: `credit`/`credits`, `photo`/`photos`, `version`/`versions` as coded.

### Header
- `LISTING LAB` (wordmark) · `My photos` · `— credits` (placeholder) · `<b>N</b> credit` / `<b>N</b> credits` · `Sign out` · chip `aria-label`: `Buy credits`

### Sign in / Create an account
- `Sign in` · `Create an account` · `AI enhancement built for real estate.`
- `Email` · `Password`
- Buttons: `Sign in` · `Create account`
- `or` · `Continue with Google`
- `No account yet?` `Create one` · `Already have one?` `Sign in`
- `By signing in or creating an account you agree to the Terms of Service and Privacy Policy. Need a hand? Message support`
- Errors: `That email and password do not match.` · `That email already has an account.` · `Use at least 8 characters.` · `That does not look like an email address.` · `Enter an email address.` · `Too many attempts — please wait a minute and try again.` · `That took too long — check your signal and try again.` · `Connection problem — check your signal and try again.` · `Something went wrong.`

### Upload
- `Start with your photos`
- `Pick one or several. Choose what to do with each, start them together, and put your phone away.`
- `Choose photos` · `JPEG, PNG or iPhone HEIC, up to 25MB each — pick as many as you like` (HTML) / `JPEG or PNG, up to 25MB each — pick as many as you like` (JS reset — inconsistent, see §1.4)
- `Converting iPhone photo…` / `Converting iPhone photos…` (+ file name)
- `Uploading <n> of <m>…` (+ file name, bar, `<pct>%`)
- Errors (joined by `; `): `<name> — over 25MB` · `<name> — not a photo format we can open (JPEG, PNG or iPhone HEIC)` · `<name> — That upload stalled — check your signal and try again.` · `<name> — Network hiccup — check your connection and try again.` · `<name> — Upload failed (<status>)` · `Nothing to upload.` · server: `Upload a JPEG or PNG.` · `That file is empty.` · `That photo is over 25MB.` · `That file doesn't look like a photo we can open. JPEG or PNG works best.` · `That's an iPhone HEIC photo even though it's named like a JPEG. Reload this page — iPhone photos now convert automatically — and upload it again.` · `Attach a photo.`
- Preview `alt`: `The photo you uploaded`

### Pick (single)
- `What should we do to it?`
- `Every result is checked before it reaches you. If nothing passes, your credits come back.`
- Options: `Declutter` · `Empty the room` · `Virtual staging` · `Twilight`; cost line `<n> credit` / `<n> credits` [` · <advice>`]
- Advice: `There is not much here to remove — expect a small change.` · `A very full room — Empty Room clears everything in one pass and succeeds more often on rooms like this.` · `This room still has a piece or two in it. Emptying it first usually stages better.`
- `Style` · `Room type`
- Style options: `Standard` · `Modern` · `Contemporary` · `Coastal` · `Luxury`
- Room options: `Living Room` · `Dining Room` · `Primary Bedroom` · `Guest Bedroom` · `Nursery / Kids Room` · `Basement / Rec Room` · `Home Office` · `Other`
- Buttons: `Back` · `Start` · `Start · <n> credit(s)` · `Not enough credits` · `Starting` (with spinner)
- Errors: `Not enough credits for that one.` · `<network message> If it doesn't appear in My Photos in a moment, try again.` · `This room is already furnished. Empty it first, then stage it.` · `That only applies to interior photos. Try Twilight for an exterior.` · `That transformation does not apply to this photo.` · `AI generation is temporarily paused. Your credits are safe and never expire.` · `No such photo.` · `Choose a photo.` · `That is not one of the four transformations.` · `Choose a style: Standard, Modern, Contemporary, Coastal, Luxury.` · `Choose a room type: Living Room, Dining Room, Primary Bedroom, Guest Bedroom, Nursery / Kids Room, Basement / Rec Room, Home Office, Other.` · `Choose a look: Dusk.`

### Batch picker
- `What should we do to each?`
- `Choose a fix per photo, then start them together. Every result is checked before it reaches you; anything that doesn't pass gives the credits back.`
- Select: `Choose a fix…` · `<Label> · <n> credit(s)` · `Skip this one`; hidden selects `aria-label` `Style`, `Room type`; fix select `aria-label` `What to do with <name>`
- Buttons: `Start over` · `Start` · `Not enough credits · needs <cost>` · `Start <n> photo(s) · <cost> credit(s)` · `Starting…`
- Errors: `That's <cost> credits and you have <balance>. Deselect one, or top up.` · `<name> — <message>; …`
- Queue notice: `Started, but <k> could not begin: <name> — <message>; …`

### Run / progress
- `Working on it`
- `This takes a few minutes, the vision model is working to ensure the images are correct.` (HTML default; never seen in practice)
- `A few minutes — we render several versions. You'll get every one that passes our checks, up to three.`
- `A couple of minutes — we inspect every detail before it leaves the lab.`
- `The image service is busy right now. Your photo is still queued — we keep trying, and nothing is charged unless it comes back.`
- `Still going. Some take longer than others — it will not give up early.`
- `Take <n> — the last one didn't meet our bar, so it's being redone. Only a pass gets delivered.`
- Steps: see §1.7 (20 strings)
- `0:00` (clock format `m:ss`)
- `You can safely close this tab — this keeps running.`
- Lost job note: `We lost track of that job.`

### Result
- `Done` (HTML default; overwritten) · `Cleared for delivery` · `It passed every check. Drag the slider to compare.`
- `ORIGINAL` · `RESULT` · knob `↔` · `alt`s: `The finished result` · `Your original photo`
- `<n> versions passed our checks — keep the one you love:` · `Version <i>`
- `Another photo` · `Save to Camera Roll` · `or download the file` · `Download`
- `AI can make mistakes — please double-check before it goes live.`
- `Now that it's empty — want to furnish it? Buyers linger longer on staged rooms.` · `Stage this room` · `One moment…`
- `Something not right with this photo?` · placeholder `Tell us what looks wrong — we read every one.` · `Send`
- Failure: `Nothing passed the checks` · `That one did not finish` · `Nothing compliant was produced.` · `The run was interrupted before it could finish.` · `Your credits have been returned.` · `The run was interrupted before it could finish. Your credits have been returned.` · `Your original photo is untouched.` · `This is the system working as intended — it would rather deliver nothing than deliver something that misrepresents the property.`
- Server `customerMessage`s: `Your work is ready.` (delivered; not displayed) · `High demand right now — your photo is queued and will be delivered as soon as capacity frees up, usually within a few minutes. If it cannot be delivered, your credits come back automatically.` (waiting; not displayed by the client) · `We could not complete this within our retry window, so your credit has been returned. Please try again shortly.` · `This one did not pass our quality and compliance checks, so your credit has been returned rather than delivering a photo we would not stand behind.`
- Escape hatch: `Rooms this full are usually beyond a tidy-up. Empty Room clears everything in one pass — and your credits are already back.` · `Try Empty Room`

### My photos
- `My photos` · `+ Add photos` · `Buy credits` · `Select`
- `Everything you've run. Finished ones stay here — you can close the app and come back whenever.`
- `Loading…` · `Nothing yet. Upload a photo to get started.`
- Badges: `READY` · `WORKING` · `RETURNED`
- Sub lines: `Waiting to start — tap to watch` · `Working on it — tap to watch` · `Image service busy — nothing charged — tap to watch` · `<Room> · <Style>` · `Tap to view` · `Credits returned — tap to see why` · `Starting it again…`
- `STATE_TEXT`: `Waiting to start` · `Working on it` · `Ready` · `Nothing passed the checks — credits returned` · `Did not finish — credits returned`
- Select bar: `0 selected` · `1 selected` · `<n> selected` · `Select all` · `Clear` · `Save to Camera Roll` · `Save <n> to Camera Roll` · `Download .zip` · `Download <n> as .zip` · `Cancel` · `Getting the photos…`
- `New photos`

### Viewer sheet
- title = transformation label (HTML default `Photo`) · `Drag the slider to compare.` · versions line/pills · `Save to Camera Roll` · `or download the file` · `Download` · AI line · chain nudge · `Something not right with this photo?` · `Send` · `Close`

### Returned-job sheet
- `Why this came back` (HTML default; overwritten) · `Nothing passed the checks` · `That one did not finish`
- `No result met our compliance and realism bar, so nothing was delivered.` · `The run was interrupted before it could finish.`
- `Your credits came back the moment it ended — this attempt cost you nothing.`
- `Rooms this full are usually beyond a tidy-up — Empty Room clears everything in one pass, same price.`
- `Try Empty Room` · `Run Declutter again` · `Try Empty Room instead` · `Run it again` · `Not now`

### Buy credits sheet
- `Buy credits` · `Credits never expire. If a photo can't be finished, its credits come back.`
- `<n> credits` · `MOST POPULAR` · `<$x.xx> per credit` · `<$xx.xx>`
- `Have a promo code?` · placeholder `e.g. LL-A1B2C3` · `Redeem` · `Not now`

### Support sheet
- `Message support` · `Goes straight to a human. We reply by email, usually same day.` · placeholder `Your email (so we can reply)` · placeholder `What can we help with?` · `Send message` · `Sending…` · `Cancel`

### Footer
- `Terms · Privacy · Message support`

---

## 3. Transformation catalogue as presented

| key | App label | Batch/select label | Credits | Extra inputs | Progress "secs" | Disclosure stamp (FAQ) |
|---|---|---|---|---|---|---|
| `declutter` | `Declutter` | `Declutter · 2 credits` | 2 | none | 150 | "Virtually decluttered" |
| `empty` | `Empty the room` | `Empty the room · 2 credits` | 2 | none | 150 | "Virtually emptied" |
| `staging` | `Virtual staging` | `Virtual staging · 2 credits` | 2 | Style + Room type | 330 | "Virtually staged" |
| `twilight` | `Twilight` | `Twilight · 1 credit` | 1 | none (style `Dusk` sent silently) | 120 | "Virtual twilight" |

- Costs are a client fallback only; `GET /api/credits` returns `costs` and overwrites them. *"A stale
  copy here is how declutter showed '1 credit' while the ledger charged 2 (Kyle caught it live, 28 Aug 2026)."*
  iOS must read costs from the server.
- Attempts: 3 per credit (`ATTEMPTS_PER_CREDIT`); a rejected render is re-done automatically up to 3
  times; if nothing passes the credits return.
- Staging styles, in order: `Standard`, `Modern`, `Contemporary`, `Coastal`, `Luxury` (default `Standard`).
- Room types, in order: `Living Room`, `Dining Room`, `Primary Bedroom`, `Guest Bedroom`, `Nursery / Kids Room`, `Basement / Rec Room`, `Home Office`, `Other` (default `Living Room`).
- Twilight times: **one look, `Dusk`, no picker.** *"Kyle, 25 Aug 2026: three moods 'convoluted the
  whole workflow'. The pipeline still supports Golden Hour and Blue Hour; the product just does not
  ask. Dusk is the one that produces the bright, pink-orange, lit-window result he grades as a pass."*
  (Server comment dates the decision 27 Aug 2026 — same decision.) Never show a twilight picker.
- Staging delivers up to three versions (`resultUrl` + `variantUrls`).
- Marketing descriptions (index.html): Declutter — *"Removes movable clutter — boxes, laundry, loose
  furniture. Architecture, fixtures, floors and perspective stay put."* Empty Room — *"Clears every
  movable object so a lived-in room shows as vacant. Blinds, built-ins and heating stay — they're the
  property."* Virtual Staging — *"Photorealistic furniture in five styles, furnished from scratch
  every time. Up to three versions with every staging — each one checked, keep the one you love."*
  Twilight — *"A daylight exterior becomes a believable dusk photograph. Lighting and sky only — the
  property is untouched."* (Full FAQ answers are in `web/faq.html`, quoted in §7.)
- Scene classification offer/advice rules: §1.5. Blocking: the server returns 422 `NOT_APPLICABLE`
  with the texts listed there; the client shows them verbatim under the Start button.
- Chains: Empty → "Stage this room" (staging runs on the **clean pre-watermark** emptied result copied
  server-side via `POST /api/photos/from-job`); rejected Declutter → "Try Empty Room".

---

## 4. Design system

### 4.1 Tokens — `web/app.html` `:root` (the app; Studio Dark)

```
--paper:#0F141B  --paper-2:#151C25  --paper-3:#1B2431
--ink:#E9EDF3    --ink-soft:#A6B1BF  --ink-faint:#75818F
--pine:#4E8FD0   --pine-deep:#14304F --pine-bright:#66A2DE
--brass:#8FBEE8  --brass-soft:#C9DFF2  --terracotta:#E17A5C
--line:#2A3545
--studio-bg:#0C1118  --studio-surface:#131A24  --studio-surface-2:#19222E
--studio-surface-3:#1F2938  --studio-line:#293546
--studio-text:#E9EDF3  --studio-text-soft:#A0ABBA  --studio-text-faint:#6B7787
--ok:#46B98A  --warn:#D9A441  --bad:#E2615A
--r-sm:6px  --r-md:10px  --r-lg:18px  --r-xl:28px
--display:"Fraunces","Iowan Old Style",Georgia,serif
--ui:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif
```
*"Tokens lifted verbatim from the Listing Lab prototype so this looks like the product Kyle has already signed off on."*
`--pine`/`--brass` are **role** names (accent / secondary), not colours — the palette is Horizon Home Media azure blue.

### 4.2 Tokens — `web/index.html` `:root` (marketing; both registers declared)

Comment: *"Two deliberate registers, not OS-theme driven: 'Studio Light': marketing / editorial
surfaces (warm paper); 'Studio Dark': the working canvas… Both are explicit, not inherited."* In
practice the marketing site is now **dark register site-wide** (*"a blue-black canvas so the light
illustrations read as the photography, with the brand blue as the single accent"*); the "paper"
names are historical. Brand: *"azure blue (from the logo, ~#3E79B9), black, white."*

```
--paper:#0F141B  --paper-2:#151C25  --paper-3:#1B2431
--ink:#E9EDF3  --ink-soft:#A6B1BF  --ink-faint:#75818F
--pine:#4E8FD0  --pine-deep:#14304F  --pine-bright:#66A2DE
--brass:#8FBEE8  --brass-soft:#C9DFF2  --terracotta:#E17A5C
--line:#2A3545  --mist:#E7EBDF  --shadow:215 25% 10%   (HSL triplet)
--studio-bg:#0C1118  --studio-surface:#131A24  --studio-surface-2:#19222E  --studio-surface-3:#1F2938
--studio-line:#293546  --studio-text:#E9EDF3  --studio-text-soft:#A0ABBA  --studio-text-faint:#6B7787
--studio-pine:#4E8FD0  --studio-brass:#8FBEE8  --studio-terracotta:#E17A5C
--r-sm:6px  --r-md:10px  --r-lg:18px  --r-xl:28px
--display / --ui: same stacks as the app
```
Pre-paint reset in `<head>`: `:root{color-scheme:light} body{font:14px -apple-system…; background:#faf9f5; color:#141413}` — a light flash-guard only; overridden by the dark tokens.

Marketing-only extras (premium treatment, 31 Aug 2026):
- Brand gradient `--grad` (faq/founder) = `linear-gradient(105deg,#5CC7F0 0%,#7FA8EC 45%,#8A7FE8 100%)` — used on the headline keyword (`.grad`), the `LAB` half of the wordmark, credit pills, founder stats. (Kyle: "keep the gradient"; "I don't wanna overdo it".)
- Gate numbers / featured tag gradient: `linear-gradient(135deg,#5CC7F0,#4a63d8)` on text `#06121e`.
- Aurora background blobs: `#1c4a75`, `#153a5e`, `#10293f` radial, blur 90px, 26 s drift.
- Final band: `radial-gradient(120% 140% at 50% 0%,#163049,#0d1620)`.
- Footer: bg `#0A0E14`, text `#C4CDD8`, headings `#7C8896`, bottom `#6B7684`, rule `#27303E`.
- Compliance band: bg `--pine-deep`, text `#EEE9DA`, border `#1F4064`, copy `#C2D2E4` / `#AFC2D6`.
- Marketing pills: approved bg `#E1EEE5`, rejected bg `#F3DED7`.
- Legal pages (`legal.css`, **light**): `--ink:#1A2230 --soft:#5A6675 --line:#E3E7EC --bg:#FFFFFF --accent:#0A62C9`, body text `#333C49`, system font 16px/1.65, max-width 760px.

### 4.3 Typography

- **Fraunces** (Google Fonts, opsz 9..144, weights 400/600/700; marketing also 500) = `--display`.
  Used for: all `h1/h2/h3` in the app (weight 600, letter-spacing −.01em, `text-wrap:balance`),
  the app wordmark (700, 22px), drop-zone big line (600, 18px), sheet titles (20px), card `h2` (20px),
  marketing headlines, hero proof numbers, marquee, price numbers. iOS: bundle Fraunces (OFL) or use
  **Iowan Old Style / Georgia** as the declared fallback.
- **Inter** (400/500/600/700) = `--ui`. Body, buttons, inputs, chips, labels. Fallback `-apple-system` — on iOS, **SF Pro** is the sanctioned fallback.
- Base: 16px / 1.55, antialiased. Inputs/buttons forced to 16px (*"16px stops iOS zooming the page on focus"*).
- Field labels: 12px, 600, uppercase, letter-spacing .1em, `--studio-text-faint`.
- `.muted` 14.5px `--studio-text-soft`; `.faint` 13px `--studio-text-faint`.
- Tabular numerals on the chip, clock and percent.

### 4.4 Radii
`--r-sm` 6px (inputs, primary buttons, option cards, error/note boxes) · `--r-md` 10px (cards, drop zone, preview, slider, pack rows, gallery cards, sheet close button) · `--r-lg` 18px (sheets) · `--r-xl` 28px (marketing hero image, bands) · 99px pills (chips, badges, knob, bar track) · 8px (batch thumbnails) · 4px (slider tags) · 9px (toast).

### 4.5 Buttons (app)
- `.btn` primary: full-width, `padding 14px 18px`, `margin-top 16px`, bg `--pine` #4E8FD0, text `#08131F`, 700, 15.5px, radius 6px, **min-height 50px** (*"a comfortable tap target on a phone"*); disabled opacity .5.
- `.btn.ghost`: transparent, text `--ink`, 1px `--studio-line` border; hover border `--pine`.
- Small variants in the gallery head / select bar: auto width, min-height 40px, `8px 14px`, 14px.
- `.linkbtn`: no background, `--studio-text-faint`, 13px, padding 6px (link-style).
- Google button: white `#fff`, text `#1f1f1f`, radius 10px, 600 15px, 18px "G" SVG.
- Sheet `.close`: full-width, transparent, 1px `--studio-line`, radius 10px, `--studio-text-soft`, padding 12px.
- Spinner `.spin`: 15px ring, 2px, `rgba(8,19,31,.35)` with dark top `#08131F`, .7 s rotation.
- Marketing buttons are pill-shaped (999px), `13px 24px`, primary bg `--pine` text `#0A1017` with blue glow shadow.

### 4.6 Cards, inputs, boxes
- `.card`: bg `--studio-surface` #131A24, 1px `--studio-line` #293546, radius 10px, padding 20px, margin-top 16px.
- Inputs/selects: `padding 12px 13px`, bg `--studio-surface-2` #19222E, 1px `--studio-line`, text `--ink`, radius 6px; custom chevron drawn from two gradients.
- Drop zone: 1.5px **dashed** `--studio-line`, radius 10px, `34px 18px`, bg `--studio-surface-2`; hover/over → border `--pine`, bg `--studio-surface-3`.
- Option card `.opt`: bg `--studio-surface-2`, 1px `--studio-line`, radius 6px, padding 14px; **selected** border `--pine`, bg `--pine-deep` #14304F, cost line turns `--brass-soft`.
- Error `.err`: bg `rgba(226,97,90,.1)`, border `rgba(226,97,90,.35)`, text `#F3B4B0`, 14px, radius 6px, `11px 13px`.
- Note `.note` (green info): bg `rgba(70,185,138,.09)`, border `rgba(70,185,138,.32)`, text `#9FE0C6`, 14px.
- Progress track: 6px, bg `--studio-surface-3`, fill `--pine`, radius 99px, width transition .6s linear.
- Steps: 14px `--studio-text-faint`; `.on` → `--ink` with `--pine` dot; `.done` dot `--ok` #46B98A; dot 8px.
- Batch row `.item`: 74×56 thumb radius 8px; rows separated by 1px `--studio-line`; states `.go` `--brass-soft`, `.ok` `--pine` 600, `.no` `--studio-text-soft`.
- Pack row `.pack`: bg `--studio-surface-2`, 1px line, radius 10px, `14px 16px`; badge `MOST POPULAR` 10.5px 700 `--pine-bright` on `--pine-deep` pill.
- Gallery card `.pcard`: bg `--studio-surface-2`, 1px line, radius 10px, hover border `--pine`, active scale .985; thumb 4:3 cover on `--studio-surface-3`; meta padding `8px 10px 10px`; name 12.5px 600; sub 11px faint.
- Badge colours: READY `#5ECD96`, WORKING `#8FBEE8` (+ pulsing 6px dot, 1.4 s), RETURNED `#E08A8A`; pill bg `rgba(9,13,21,.82)`, white default text.
- Select tick: 24px circle, 2px `rgba(255,255,255,.85)` border on `rgba(9,13,21,.55)`; picked → bg/border `--pine`, tick `#0A1017`, card ring `0 0 0 2px --pine inset`.
- Sheets: bg `--studio-surface`, 1px line, top radius 18px on phone / all corners ≥560px (centred, 24px padding), max-width 440px (viewer 560px), max-height 82dvh, padding `14px 20px calc(20px + safe-bottom)`, grab bar 36×4 `--studio-line`; overlay `rgba(8,11,16,.62)` + blur 3px; slide-up .24 s ease-out from 24px/opacity .4.
- Toast: `#1c1d1c` bg, `#f2ede6` text (note: the only warm-paper colours left in the app).

### 4.7 Logo and icon files (`web/`)

| file | size | use |
|---|---|---|
| `logo-full.png` | 192×192 | the mark. App header at 36×36 next to the wordmark; marketing nav at 27→46/52px; footer; `Organization.logo` in JSON-LD. |
| `favicon-32.png` | 32×32 | browser favicon (`?v=3`) |
| `icon-192.png` | 192×192 | favicon/PWA icon |
| `icon-512.png` | 512×512 | large app icon — the source for the iOS app icon set |
| `apple-touch-icon.png` | 180×180 | iOS home-screen icon (`?v=3`) |
| `social-card.jpg` | 1200×630 | Open Graph / Twitter card |
| `img/site/kyle.jpg` (1000×1250 portrait), `img/site/kyle-face.jpg` (30px round) | founder page / trust line |
| `img/site/*.jpg` (23 files: `ext.day/dusk`, `bed1.occ/declut/empty/staged`, `bed2.occ/declut/empty/staged`, `liv.day/coastal/dining/office`, `kliv.empty/staged`, `kbed.empty/std/lux`, `koff.empty/staged`, `col.day/dusk`) | real before/after examples for the marketing sliders |

Wordmark rendering: app = Fraunces 700 `LISTING` in `--ink` + `LAB` in `--pine`; marketing = Inter 800 uppercase letter-spaced `LISTING` with `LAB` in the brand gradient, pulled in −0.18em (Kyle, 31 Aug). Kyle's real logo replaced the earlier drawn mark on 28 Aug 2026.

### 4.8 Layout, safe areas, fixed/sticky elements, spacing
- Viewport `viewport-fit=cover`; `body` padding = `env(safe-area-inset-*)` on all four sides (*"iPhone notch"*).
- Content column `.wrap`: max-width **640px**, side padding 18px, bottom padding 96px; **1180px** while My photos is open (`body.wide`) — the header widens with it.
- Header: `position:sticky; top:0; z-index:20`, bg `rgba(12,17,24,.92)` + 8px blur, 1px bottom line; inner padding `12px 18px`, gap 12px.
- Select bar: `position:sticky; bottom: calc(10px + safe-bottom); z-index:30`, shadow `0 10px 30px -10px rgba(0,0,0,.6)`.
- Sheets: `position:fixed; inset:0; z-index:60`, bottom-anchored on phones (*"Lives at the end of `<body>`, NOT inside the header: the header's backdrop-filter turns it into the containing block for fixed children"*). Toast `z-index:80`.
- Spacing rhythm: 16px between cards and major blocks (`margin-top:16px` everywhere); 14px for fields/notes/errors; 10px grid gaps (14px in the wide gallery); 12px header gap; 8–9px between steps/pills; 40px above the footer.
- Grid: options 2 columns; gallery 2/3/4/5 columns by width.
- Focus ring: 2px `--pine`, offset 2px. Reduced motion: spinner, bar transition and sheet animation off.
- Mobile chrome intent from the prototype (index.html): *"On phones the app gets native-app chrome instead of shrunk desktop UI: a fixed bottom tab bar (matching the eventual iOS app), an icon-only top bar."* The shipped app does **not** have a tab bar; the prototype's is a hint only.

---

## 5. Timing constants

| Constant | Value | Where | Reason (verbatim where given) |
|---|---|---|---|
| API request timeout | **45 000 ms** (`timeoutMs` default) | `api()` | *"the target user is an agent on a driveway with one bar of signal. A connection that stalls without a reset… leaves a bare fetch() pending forever"* (security review, 31 Aug 2026) |
| Upload stall timeout | **60 000 ms**, reset on every progress event | `uploadOne` | *"Large photos on slow 5G can legitimately take a while… only a truly dead connection trips it."* (Review, 31 Aug) |
| Scene poll | **1 200 ms × 15** (≈18 s max) | `pollScene` | background classification; silent |
| Job poll | **4 000 ms** | `startWatching` | *"Poll gently. Nothing here is in a hurry and the job takes minutes."* |
| Progress tick | **1 000 ms** | `startWatching` | clock, bar, steps |
| Bar easing | `90·(1−e^(−t/(secs/2.6)))`, cap 90% | | honest estimate; 100% only on finish |
| Step pacing | `secs / 5` per step, last step never by clock | | Kyle, 28 Aug 2026 |
| Plan `secs` | twilight 120 · declutter 150 · empty 150 · staging 330 | `STEPS` | *"roughly how long that job takes, and paces the bar honestly"* |
| "Still going" threshold | `secs × 1.6` (192 / 240 / 240 / 528 s) | tick | |
| Server give-up | **15 min** (`GIVE_UP_AFTER_MS`) | `src/worker.js` | Kyle, 31 Aug 2026: *"Agents don't wanna wait forty minutes…"* |
| Server stale re-dispatch | 12 min (no heartbeat) / 3 min (heartbeat lost) / 2 min (never first-beat) | server | not user-visible |
| Queue poll | **6 000 ms**, only while something is queued/running | `startQueueWatch` | *"should not sit there asking every few seconds all afternoon"* |
| Post-checkout balance refresh | **1 500 ms** and **4 500 ms** (+ toast) | page load | *"The webhook can land a beat after the redirect"* |
| Auth-error toast delay | 400 ms | page load | let the page paint first |
| Toast visible | **3 200 ms**, fade .3 s | `toast()` | |
| Sheet slide-up | .24 s ease-out | CSS | |
| Bar width transition | .6 s linear | CSS | |
| Spinner | .7 s linear infinite | CSS | |
| WORKING badge pulse | 1.4 s ease-in-out infinite (opacity .35→1) | CSS | |
| Hover transitions | .15 s (border/bg), .12 s (card press) | CSS | |
| Marketing: hero rotator | 5.5 s per slide, 9 s hold after touch, .7 s crossfade, phones only | index.html | Kyle, 28 Aug 2026: "maybe just for mobile" |
| Marketing: marquee | 36 s loop | | |
| Marketing: reveal safety net | 2 s | | *"nothing stays hidden past 2s"* |
| Marketing: counter | 120 ms per tick after 300 ms | | |
| Max upload size | 25 MB | client + server | *"A 4K phone photo is a few MB; 25 is generous"* |
| Jobs listed | 60 newest | server | |
| Zip max | 60 jobs | server | |
| Report max length | 2000 chars; support 4000 | textareas | |
| Rate limit sign-in/up | 10 / min / IP | server | |

---

## 6. Owner decisions recorded in code comments (one line each)

Every comment mentioning Kyle in `web/app.html`, `web/index.html` (and the server rules the app depends on). Dates as written.

**`web/app.html`**
1. (undated) Tokens lifted verbatim from the prototype *"Kyle has already signed off on"* — do not restyle.
2. 25 Aug 2026 — Twilight has **one** look (`Dusk`) and **no picker**; three moods "convoluted the whole workflow". (Server dates it 27 Aug.)
3. 28 Aug 2026 — The **server owns prices**; the client's cost table is a fallback only (declutter showed "1 credit" while charging 2 — Kyle caught it live).
4. 28 Aug 2026 — Slider drag must never select the page or ghost-drag the photo ("highlight-everything bug").
5. 28 Aug 2026 — Run-screen wording: staging *"A few minutes — we render several versions. You'll get every one that passes our checks, up to three."*; kept **off receipts and anything near payment**.
6. 28 Aug 2026 — The clock **never lights the final step**; only a real delivery does.
7. 28 Aug 2026 — **Chain nudge**: after an Empty result, offer "Stage this room" (staging runs on the emptied result).
8. 28 Aug 2026 — **Escape hatch**: a rejected Declutter offers "Try Empty Room".
9. 29 Aug — Brand line-height 1.05 so a wrapped LISTING/LAB has no gap.
10. 29 Aug — My photos is a **photo grid** with status badges, 2 columns on phone / 3 wider — not a settings list.
11. 29 Aug — **One obvious button**: `Save to Camera Roll` via the share sheet; Download demoted to a quiet line (people tapped Download and lost photos to Files).
12. 29 Aug — The chain nudge also appears in the library viewer.
13. 29 Aug — The quiet report line also appears in the viewer (it had existed only on fresh delivery).
14. 29 Aug — Viewer sheet: library is as capable as the delivery moment (slider, versions, save).
15. 29 Aug — **Support box** instead of a mailto link; works signed out with a reply address.
16. (undated) Report link must be **discreet** ("make it discreet") — faint text, not a button inviting complaints.
17. 31 Aug 2026 — Tapping a WORKING card returns to the progress screen; the clock resumes from the job's real start.
18. 31 Aug 2026 — Returned cards can be re-run in one tap (born from the beta morning when an outage failed two jobs and the customer's only road back was re-uploading and texting Kyle).
19. 31 Aug 2026 — Returned-**declutter** chooser leads with the option that fits how it ended (rejected → Empty Room first; failed → Declutter again first); same cost either way.
20. 31 Aug 2026 — A returned card must never be a dead end that just says FAILED — show the reason verbatim.
21. 31 Aug 2026 — HEIC accepted and converted client-side (beta finding); a HEIC renamed .jpg is sniffed by bytes (it killed a real customer job).
22. 31 Aug 2026 — "Stage this room" copies the **clean, pre-watermark** frame (the stamped one taught the model to redraw the stamp).
23. 1 Sep 2026 — Accept both `jobId` and `id` shapes forever (Kyle's "no such job").
24. 1 Sep 2026 — Scene classification runs in the background; buttons narrow quietly, never under the user's thumb.
25. 3 Sep — On desktop the library widens to 1180px and 4–5 columns ("it's pretty skinny and tall").
26. 3 Sep 2026 (audit) — Credit chip is a real button; 401 anywhere reloads to sign-in; refund is stated on the fresh-failure screen; resumed jobs carry the photo so "Try Empty Room" works.
27. 5 Sep 2026 — Every transformation's step list ends with "Applying the disclosure"; exterior steps never claim to measure a room.
28. 6 Sep 2026 — *"AI can make mistakes… please double check"* — one quiet line on every result.
29. 9 Sep 2026 — **Select mode**: "group download from the My Photos page" — multi-save to camera roll or one server-built ZIP.
30. (undated, upload comment) No `capture` attribute — the photo library must be offered, not just the camera.
31. (undated) Uploads and batch starts are **sequential**, never parallel, for driveway signal.
32. (undated) A Start that times out sends the user to My Photos rather than inviting a blind re-tap that could double-charge.

**`web/index.html`**
33. 28 Aug 2026 — Hero proof: three equal centred columns on phones.
34. (undated) Slider drag must not blue-highlight the page ("the blue highlight Kyle saw").
35. 28 Aug 2026 — Hero rotator through all four examples on **mobile only** ("maybe just for mobile"); desktop rests on the staging proof.
36. 28 Aug 2026 — The real Listing Lab logo replaces the drawn placeholder mark everywhere.
37. 28 Aug 2026 — Marquee is just the four transformations, larger; trust copy "felt copy-pasted" there.
38. 31 Aug 2026 — Premium treatment approved on the live demo: aurora glow, capabilities **before** philosophy, copy untouched.
39. 31 Aug — Wordmark: pull LAB in (−0.18em) and give it the headline gradient on every wordmark.
40. 31 Aug — More air between the ticker and Capabilities.
41. (undated) Flare used sparingly ("I don't wanna overdo it") — gradient only on credit pills, gate numbers, keyword, LAB.
42. 31 Aug — MOST POPULAR tag centred on the card's top edge.
43. 31 Aug — The "canyon" between the compliance band and Pricing shrunk.
44. (undated) "keep the gradient" — headline keyword gradient stays.
45. 3 Sep 2026 — A signed-in agent landing on the home page sees their name and "Open the studio", not "Sign In".
46. 30 Aug 2026 (temporary, beta) — Top strip `Have a code? Redeem it here — no purchase needed →` linking to `/app#promo`; remove when the beta-code wave is over.

**Server (`src/*.js`) decisions the app surfaces**
47. 28 Aug 2026 — Pack pricing "Option A": 10/$19.99, 30/$56.99, 75/$137.99 (~$2/credit, modest bulk discount after earlier discounts "were giving away too much").
48. 28 Aug 2026 — Costs 2/2/2/1 priced from measured delivery cost.
49. 28 Aug 2026 — Routing insight: very full rooms get the "Empty Room clears everything in one pass" advice on Declutter — steer, never block.
50. (undated) A room with two boxes is *both* a declutter job and stageable — the classifier must never bucket a photo into one label.
51. 31 Aug 2026 — Give up and refund at 15 minutes (down from 40).
52. 1–2 Sep 2026 — Container pool 4→8→15 so a 30-photo drop runs without our own queue as the bottleneck ("should be at fifteen at minimum").
53. (undated) Kyle's workflow: queue three or four images, close the phone, come back and they're all done.

---

## 7. Links and pages

Base URL `https://thelistinglab.app`. Support email: **support@thelistinglab.app** (JSON-LD, footer, FAQ, terms, privacy, founder; the in-app Support sheet posts to `/api/support` instead of mailto).

| Path | Title | One line |
|---|---|---|
| `/` | Listing Lab — AI enhancement built for real estate | Marketing page: hero "AI enhancement built for real estate.", four capability sections with real before/after sliders, the seven-gate compliance band, pricing (10/30/75 credits), founder trust line, final CTA. Dark register; Kyle-approved premium treatment. |
| `/app` | Listing Lab | The customer app documented here. |
| `/faq` | FAQ — Listing Lab | 21 Q&As in five groups (Getting started, The four transformations, Quality and compliance, Credits and pricing, Your photos): file types incl. HEIC up to 25 MB, timings (1–3 min; staging longer; 15-minute stop and refund), resolution up to 4K no upscaling, what each transformation removes/keeps, the disclosure stamp wording, MLS responsibility, credits 2/2/2/1 never expire, packs, non-refundable purchases, ownership stays with the user, privacy. Ends: "Email support@thelistinglab.app. It goes to the photographer who built this, not a ticket queue." |
| `/terms` | Terms of Service — Listing Lab (Last updated September 6, 2026) | Horizon Home Media, Massachusetts. Users keep all rights; disclosure stamp must not be removed/cropped; credits non-transferable, never expire, auto-returned on failed/rejected jobs, purchases non-refundable except by law; review every image before publishing; service "as is", liability capped at 12 months' payments. |
| `/privacy` | Privacy Policy — Listing Lab (Last updated September 3, 2026) | Collects email + salted-hashed password, photos/results, job records; Stripe handles cards; one HttpOnly session cookie, no ad trackers; photos processed by Google Gemini image services, stored on Cloudflare; never sold/shown to others; deletion on request within 30 days; not for under-16s. |
| `/founder` | Who built this — Listing Lab | Kyle Silva: "A photographer who got tired of watching good photos get butchered." 1,000+ listings, 4 yrs behind the camera, former licensed agent; three beats (The problem / The license / The fix); "The standard is mine." CTA to the app and FAQ; "Questions go to me: support@thelistinglab.app". |
| `/owner` | (owner dashboard, linked faintly in the footer as "Owner") | Not a customer page; ignore for iOS. |
| `/api/auth/google` | — | Starts Google sign-in (web redirect). |
| `/app#promo` | — | Deep link that opens Buy credits with the promo field expanded. |

Legal links inside the app open in a new tab (`/terms`, `/privacy`) from both the auth card and the footer.

**Prototype note.** `web/index.html` lines ~1042–2557 contain an older in-page prototype SPA
(mock listings, a demo sign-in/sign-up with name + brokerage fields, a "forgot password" flow, a
bottom tab bar, `declutter` at cost 1, two-version staging). It is **not** the product and
contradicts the shipped app in places; only its marketing render (`renderMarketing`, hero rotator,
`showWhoIsSignedIn`) is live. Do not build from it. There is no password-reset flow in the shipped app.

---

## 8. Things that are unclear or inconsistent (flag to the owner)

1. Drop-zone sub line: HTML says `JPEG, PNG or iPhone HEIC…`; the JS reset string `DROP_IDLE` says `JPEG or PNG…`. Which wording is canonical?
2. Twilight decision date: app comment says 25 Aug 2026, server comment says 27 Aug 2026. Same decision (Dusk only).
3. Batch picker rows do not re-narrow when a photo's classification arrives after render; the server rejects inapplicable picks at Start with a per-row error. Intended iOS behaviour: live-narrow the row (the comment says the batch is "not a different rulebook").
4. Batch twilight jobs are sent without `style:'Dusk'` (single flow sends it). Harmless (server has one look) but inconsistent.
5. Leaving the run screen via header `My photos` (or the brand link) does not stop the job poll; when the job finishes the result card appears while the queue card is still visible. iOS should treat the queue as the destination and stop the run-screen poll on leave.
6. The comment `state.batch` shape (`file`) differs from the real objects (`name`); the File is not kept.
7. `MOST POPULAR` is hard-coded client-side to `pack_30` rather than coming from `/api/packs`.
8. `customerMessage` for the waiting-on-upstream state exists on the server but the client uses its own sentence on the run screen; both are quoted above — pick one.
9. The `Google` sign-in flow relies on web redirects and a cookie; iOS needs a native equivalent (ASWebAuthenticationSession or Sign in with Google → the same `/api/auth/google/callback` contract — see API.md).
10. There is no in-app account page, password change, or password reset. Confirm whether iOS should add any (App Store review may require account deletion in-app; today it is by support request).
