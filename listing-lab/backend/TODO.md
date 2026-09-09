# Listing Lab — the running list

Kyle: "I seem to forget things, and I like you to refresh me." This file is that
refresh. Launch-day sequence lives in LAUNCH.md; this is everything else.

## Post-launch (queued, in rough priority order)

1. **Aryeo credit-pack add-on pipeline** (settled design, 28 Aug 2026):
   dormant promo codes derived from the order number ("LL-{order#}", printed by
   his existing automated order confirmation via the order-number template
   variable), minted dormant when an order containing a credit-pack add-on is
   created, activated by the Aryeo webhook when the order flips to FULFILLED.
   His call on fulfilled-not-paid: agents always pay; exposure is AI cost, not
   retail. Needs from Kyle when we start: one real order-confirmation template
   (confirm the order-number variable) and one sample webhook payload from the
   relay. A few days' work.

2. **Declutter hard tail** — shipped at 79% on the golden nightmare set by his
   decision; heavy-clutter uploads steer to Empty Room (92%). Revisit ONLY if
   production data shows heavy-clutter declutters failing at a rate that hurts.
   The dashboard's failure list is the tripwire.

3. **Push past 95% on empty room / others** — his "we may revisit at a later
   date" from the empty-room loop close. Data-driven, not urgent.

4. **Native iOS app, full SwiftUI (no wrapper)** — his all-in decision, a few
   months out. Backend is ready as-is; the work is screens + push notifications
   + Sign in with Apple. Decide credits-purchase model (Apple's cut vs
   buy-on-web) at build time under whatever the rules are then.

5. **New-client Facebook promos** — no build needed: he mints codes on
   /internal/board/promos whenever he runs a campaign ("first shoot with
   Horizon = 10 Listing Lab credits").

## Waiting on Kyle (his own list, from LAUNCH.md)

- Stripe live key (new Listing Lab account under his verified dashboard).
- GoDaddy nameservers → Cloudflare, auto-renew ON.
- Google console: add thelistinglab.app redirect URI + Publish app.
- Lawyer pass on /terms + /privacy before charging strangers (his risk call).
- Cloudflare billing: add PayPal as backup payment method (protects HHM too).

## Done recently (so the refresh has receipts)

- 2–3 Sep: the teardown to one judge + instruments (graded 44→56/63, then
  69–71/80 on the expanded set); poisoned-slot defense (probe, hop,
  quarantine, fleet cycle); fal-first generation + fal queue fallback; frame
  lock on twilight and staging; twilight ugly floor; hung-clothes and fan
  rulings; region close-up review for masked declutters; grader `since=`
  filter; landing-page blank-hash and Back-trap fixes; pre-launch audit
  (`/tmp/listinglab-prelaunch-audit.md` in the audit session — its P0/P1 list
  is the launch checklist); README/OPERATIONS/HANDOFF refreshed.

- 28 Aug: download bug, Option A pricing, credit costs 2/2/2/1, logo + badge
  favicon, buy-sheet redesign, upload progress, honest progress steps, Empty
  Room routing nudges, staging Versions (up to 3), promo codes + owner mint
  screen, problem reports + owner queue, measured per-job AI cost on the
  dashboard, support@thelistinglab.app site-wide, social share card, copy pass
  (headline, ticker, eyebrow, footer), Google sign-in live, Stripe test loop
  proven, git + backups, launch runbook + rehearsed wipe.

## Beta findings (29 Aug, amateur-photo test)
- Declutter kept a framed picture leaning on the floor half-behind the
  entertainment center (family-member phone shot, night interior). Root cause:
  the judge deliberately protects framed art — floor-leaning frames are
  ambiguous (staging look vs. not-yet-hung clutter). One sample; the Empty Room
  nudge HAD fired and the user chose declutter anyway. If it repeats: add a
  scoped line to the declutter brief (unhung frames on the floor, partially
  occluded by furniture = clutter) and re-validate against the golden set
  before shipping. Otherwise leave — cosmetic, not compliance.

## Marketing plan pile (from the 4 Sep 2026 growth plan)
- [ ] Week 5 (5–11 Oct): MLS PIN pilot one-pager — add the cap line ("up to 1,500 checked images across the pilot group"), fill phone/email, send to the Chief Strategy & Partnership Officer with the CEO copied once a shareholder brokerage office is live on a code. Draft lives at /tmp/plan/mlspin-pilot.md (PDF delivered 4 Sep).
