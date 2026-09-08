# Gameplan

An iOS companion for ESPN Fantasy Football that answers one question every week:

**What should I do to give myself the best chance of winning?**

Not another projections dashboard. Gameplan reads your roster, your matchup, your
league's rules and the waiver wire, works out where you actually stand, and hands
you a short ranked list of moves — each one explaining itself.

---

## Opening it

```
open Gameplan.xcodeproj
```

Select an iPhone simulator and run (⌘R). Tests: ⌘U, or:

```
xcodebuild test -project Gameplan.xcodeproj -scheme Gameplan \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

Requirements: Xcode 16 or later, iOS 17 deployment target. There are no package
dependencies — everything is first-party frameworks (SwiftUI, Swift Charts,
UserNotifications, CryptoKit, Security).

The project uses Xcode's file-system-synchronized groups, so adding a file to a
folder adds it to the target — no `.pbxproj` edits needed. A `project.yml`
(XcodeGen) spec is also committed as a regeneration path if the project file is
ever damaged: `brew install xcodegen && make project`. `make help` lists the
other shortcuts.

You do **not** need any credentials to try the app. On first launch you can pick
"Explore with a demo league" and every screen works end to end.

---

## The idea

The app's objective is `P(my score > opponent's score)` — not projected points.
Those are different problems, and the difference is where the advice comes from:

- When you are **likely to win**, a lower-variance player is worth more than a
  higher-variance one with the same projection. A bad week is the only way you
  lose.
- When you are **likely to lose**, the reverse. An average week loses anyway, so
  the upside player is the better play.

Nothing about that is special-cased. It falls out of maximising the probability
directly, which is why it stays sensible in the awkward middle cases where a rule
of thumb would not.

### Three layers, kept separate

| Layer | What it does | Where |
|---|---|---|
| **Facts** | Verified data from your league and research sources. Nothing is invented; missing data stays `nil`. | `Core/Models`, `Core/Providers`, `Core/Research` |
| **Analysis** | Deterministic calculation. Projections, distributions, lineup optimisation, waiver scoring. Testable, offline, free. | `Core/Engine` |
| **Interpretation** | Turning evidence into readable prose. Optional, and structurally prevented from inventing figures. | `Core/AI` |

Every number the user sees is tagged with which of these produced it:
**measured** (from your league's data), **calculated** (by Gameplan), or
**estimated** (a model assumption used because data was missing).

---

## How the engine works

**Projections.** If your league publishes one, that is the starting point. If not,
one is derived from the player's own usage. Either way the app then builds a
*distribution* — a floor and a ceiling — from how much that player's scoring has
actually varied, widened when there is an injury question. A questionable player
is modelled as a mixture of "plays" and "doesn't", which correctly collapses their
floor while leaving their ceiling intact.

**The matchup.** Both lineups are treated as distributions with a small allowance
for the fact that teammates score together. Win probability is the chance yours
lands above theirs. Your opponent is always assumed to start their best legal
lineup, so your position is never overstated.

**Lineup advice.** The optimizer seeds a strong lineup greedily, then improves it
with pairwise swaps until nothing helps. The difference from your current lineup
is decomposed into individual swaps, each scored by the win probability it is
actually worth — which is what lets the app say "this one matters, that one
doesn't" instead of listing nine equal-looking changes.

**Waivers.** Explicitly *not* ranked by projection. Each available player is scored
on how much they would add to your starting lineup right now, how far clear of
replacement level they are *in a league of your size*, whether they fix your
weakest position, and how stable their role looks. A great player who would sit on
your bench scores low.

**Trades.** The app finds structural mismatches (deep here, thin there) and
proposes a direction. It does not price trades — what a manager will accept is not
in any dataset — and says so.

---

## Keeping the AI honest

The optional language-model layer never sees free-form data. It receives an
`EvidencePack`: a structured JSON object containing only facts the app has already
verified or calculated. It is instructed never to introduce a statistic it was not
given.

Then, because instructions alone are not a guarantee, `NarrationValidator` extracts
every number from the generated text and rejects the response if any of them is
absent from the evidence pack. A rejected response is discarded and the on-device
writer's wording is used instead.

**The on-device writer is the default and is not a placeholder.** It runs instantly,
costs nothing, works offline, and cannot hallucinate. The remote layer exists to
make the prose better, never to make the app work.

### Cost control

- Analysis is keyed by a fingerprint of the inputs (week, league rules, both
  rosters, each player's slot, health and projection). Identical inputs reuse the
  cached plan.
- Opening the app, switching tabs, or revisiting a screen never triggers a model
  call.
- Cheap deterministic calculation and expensive interpretation are separate calls,
  so only the second one is avoided.

---

## What needs your configuration

Everything below is optional. The app is fully functional without any of it.

### 1. ESPN league (optional — demo mode works without it)

**More → Data source → Connect ESPN league.**

- **League ID** — the number in your ESPN league URL after `leagueId=`.
- **`espn_s2` and `SWID`** — only for private leagues. Copy them from the cookies
  of a browser you are signed into ESPN with; the app has step-by-step
  instructions built in.

Stored in the device Keychain (`kSecAttrAccessibleAfterFirstUnlock`), never
logged, and sent only to ESPN. The app never asks for an ESPN password.

**Please read this honestly:** ESPN publishes no supported public API for fantasy
football. Gameplan reads the same read-only endpoints ESPN's own web app calls.
They are stable in practice but are not a contract and can change without notice.
That is exactly why the app talks to a `FantasyDataProvider` protocol rather than
to ESPN directly — if these break, or a supported API appears, or you want Sleeper
or Yahoo instead, only `Core/Providers/ESPN/` changes. Nothing in the models,
engine or UI knows ESPN exists.

### 2. Language-model explanations (optional)

**More → Analysis → AI explanations.**

Supply an HTTPS endpoint you control, plus an optional bearer token. The app
POSTs `{ systemPrompt, userMessage, evidence }` and expects back
`{ "headline": "...", "positioning": "...", "moveSummaries": { "<moveId>": "..." }, "restingEasy": "..." }`
(a `{ "narration": { ... } }` wrapper is also accepted).

**No model API key is ever stored in the app**, because a key shipped inside an iOS
binary is readable by anyone who downloads it. Your backend holds the key. The
token you give Gameplan goes in the Keychain.

### 3. Weather (works with no configuration)

Game-day forecasts come from **Open-Meteo**, which is free for non-commercial use
and needs no API key — which is why it was chosen over sources that would require
a secret in the app. If it is unreachable, the app proceeds without weather and
says so in its data-quality note.

---

## Known limits

Stated plainly rather than buried:

- **No NFL schedule source.** The demo league carries its own opponents and
  kickoff times. A real ESPN league does not expose per-player opponent, so with
  ESPN connected the app cannot yet apply matchup or weather adjustments, and it
  reports that in the data-quality note. Adding a schedule provider is a
  `ResearchProvider` conformance and nothing else.
- **No betting-market data.** No free, licence-clean source was assumed. The
  `BettingContext` model and its adjustments exist and are wired through; supply a
  provider and they activate.
- **Bye weeks** come from the fantasy provider. ESPN does not return them on the
  player payload, so bye detection is currently demo-only.
- **Trade values are not modelled**, deliberately.
- **Waiver bids are recommendations**, not market prices. Nobody can see what your
  leaguemates will bid, and the UI says so every time it shows a number.

---

## Layout

```
Gameplan/
  App/            Composition root, app state, root navigation
  DesignSystem/   Theme + shared components
  Features/       One folder per screen
  Core/
    Models/       Domain types — no UI, no networking
    Providers/    FantasyDataProvider protocol, ESPN, demo league
    Research/     News, weather, betting context
    Engine/       Projections, optimizer, waivers, trades, game plan
    AI/           Evidence pack, narrators, prompt, validator
    Persistence/  Cache, Keychain, preferences
    Util/         Statistics, calendar, fingerprinting, logging
GameplanTests/    Engine, provider, cache and validator tests
```

`Core/` imports only Foundation. It has no dependency on SwiftUI, on the app
target, or on any specific data source, and is designed to lift out into its own
package unchanged.

---

## Tests

`GameplanTests` covers the parts where being wrong is expensive:

- The statistics everything rests on (normal CDF against known values, variance
  aggregation, win probability).
- **The behaviour that defines the product**: that a favorite prefers the safer
  player and an underdog prefers the riskier one at equal projection.
- Projection handling of injuries, byes, practice participation, matchup, weather,
  and observed-versus-assumed variance.
- Roster assessment, replacement level, and league-size sensitivity.
- That waiver ranking is not "highest projection wins", that suggested drops are
  never starters, and that bids stay inside the budget.
- That the validator rejects an invented statistic and accepts a rounded one — and
  that the app's own writer passes the same check it holds a model to.
- ESPN's numeric ID mappings and scoring derivation.
- Cache expiry, fingerprint stability, and season/week arithmetic.
- An end-to-end run over the demo league asserting the plan is ranked, capped,
  deduplicated, explainable, and deterministic.

---

## Not affiliated

Gameplan is an independent companion app. It is not affiliated with, endorsed by,
or connected to ESPN or the NFL. The demo league is entirely fictional — invented
players with invented statistics — so that no fabricated data is ever attached to
a real person.
