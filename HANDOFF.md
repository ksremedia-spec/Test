# Handoff

Read this first. It is a briefing for a fresh session picking up this project,
written by the session that built it.

## Who you are working with

The owner is not a developer. They have shipped an app before and know their way
around Xcode, but **jargon loses them** — they have asked explicitly for plain
English. Explain in terms of what something does, not how it is implemented. Say
"the app doesn't know who each team plays" rather than "the schedule provider
returns an empty array."

## What this is

**Gameplan** — an iOS companion for ESPN Fantasy Football. Every week it reads
your team, works out where you stand, and gives a short ranked list of what to do
with the reasoning behind each recommendation.

The product idea it turns on: the engine maximises `P(my score > opponent's
score)`, **not** projected points. A favorite is steered toward higher-floor
players because a bad week is the only way they lose; an underdog toward
higher-ceiling ones because an average week loses anyway. That behaviour is not
special-cased — it falls out of optimising the probability directly. Do not
"simplify" it into a points comparison.

## State of play — read this carefully

The entire app is written. **None of it has ever been compiled.** The session that
built it ran in a Linux container with no Swift toolchain (`download.swift.org`
was blocked by egress policy), so every line was written blind and reviewed by
hand.

Expect a first-build error list. That is anticipated, not a surprise.

Also unverified: the ESPN public feeds in `Core/Research/ESPN/`. Those were
written from community documentation of endpoints ESPN publishes no spec for, and
never called — the sandbox blocked those hosts too.

What *is* verified: the engine's arithmetic. It was ported to a scratch harness
and run over the demo league, which confirmed the favorite/underdog behaviour, the
win-probability maths, and the specific numbers the demo produces (103.4 vs 116.6,
a 34.5% week, +7.9 points of win probability on the top lineup move). Three real
bugs were found and fixed that way.

## First jobs, in order

1. **Make it build.** `open Gameplan.xcodeproj`, ⌘B, work the errors. Then ⌘U for
   the tests — there are ~110 covering the engine, the providers and the caching.
2. **Run it.** It opens on a fictional demo league that needs no credentials, so
   the whole app is explorable immediately. Check the Game Plan tab reads sensibly.
3. **Verify the ESPN public feeds.** These have never been called. Easiest path:
   run the app, pull to refresh, then open **More → Diagnostics**, which records
   what each feed actually returned. Fix the wire types in
   `Core/Research/ESPN/ESPNPublicDTO.swift` against reality.
4. **Then** the remaining roadmap below.

## Architecture, briefly

```
Gameplan/
  App/            Composition root (AppEnvironment), app state (AppModel), navigation
  DesignSystem/   Theme + shared components
  Features/       One folder per screen
  Core/
    Models/       Domain types — Foundation only, no UI, no networking
    Providers/    FantasyDataProvider protocol + ESPN + a fictional demo league
    Research/     NFLContextProvider (schedule/odds/injuries/depth), weather, news
    Engine/       Projections, lineup optimizer, waivers, trades, game plan
    AI/           Evidence pack, narrators, prompt, anti-hallucination validator
    Persistence/  Cache, Keychain, preferences, diagnostics
    Util/         Statistics, calendar, fingerprinting, logging
```

Two seams matter:

- **`FantasyDataProvider`** — your league. ESPN today; swapping in Sleeper or Yahoo
  is one new conformance and nothing else changes.
- **`NFLContextProvider`** — facts about the NFL rather than about a league
  (schedule, betting line, injury report, depth chart). Deliberately separate,
  because those are the same for everyone regardless of platform.

`Core/` imports only Foundation and is designed to lift out into its own package.

## Things worth knowing before you change anything

- **The schedule is the keystone.** Without knowing who each team plays, there is
  no stadium to check weather for and no defense to grade a matchup against. The
  enrichment step fetches games *first* and everything else hangs off it.
- **ESPN's fantasy `proTeamId` and the public API's team id are the same numbers**,
  and so are athlete IDs across both. That is the only reason injury and
  depth-chart data can be joined onto a league roster. Don't build a second
  mapping table.
- **Every number shown to the user is labelled** measured / calculated / estimated.
  Keep that. It is what stops confident-sounding advice being mistaken for
  certainty.
- **The AI layer cannot invent figures.** It receives a structured evidence pack
  and a validator rejects the whole response if any number in it is absent from
  that pack. There is a test asserting the app's own on-device writer passes the
  same check. If live web research is added, that guard must change from "no new
  numbers" to "new numbers only with a source link" — not be removed.
- **Kickers and defenses are excluded** from "your biggest problem". They are
  streamed weekly; naming one would be accurate and useless.
- **Route participation is not available in-season** from any free source. Use
  snap share, which does update weekly.
- **No API keys in the app, ever.** ESPN session cookies live in the Keychain. A
  language-model key would have to live on a small server the owner runs; the app
  already has the slot for it (`RemoteNarrator`).

## Roadmap after the build is green

1. Confirm the ESPN public feeds against real payloads (see Diagnostics).
2. A small server to hold a language-model key, so AI explanations can be turned
   on. The app expects an HTTPS endpoint returning
   `{headline, positioning, moveSummaries, restingEasy}`.
3. Live web research for injury news and beat-reporter context — the half of the
   picture no structured feed carries.
4. Snap counts and practice participation from nflverse, which needs that same
   server to reshape the data for a phone.

## Rough edges the owner already knows about

- The top six recommendations are currently dominated by waiver adds, and several
  suggest dropping the same player. Faithful to the engine as written; worth
  tuning (cap waiver moves on the home screen, and exclude drops already spoken
  for).
- Five commits carry the wrong author email and show as Unverified on GitHub.
  Cosmetic. Fixed with a rebase and a force-push if it bothers anyone.
