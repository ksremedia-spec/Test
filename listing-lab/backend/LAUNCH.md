# Listing Lab — launch runbook

The order of operations for going live on thelistinglab.app. Written 28 Aug 2026;
each item says WHO does it. Nothing here is destructive except the wipe, which
is last and gated on Kyle's explicit go.

## 1. Domain (Kyle starts it, assistant finishes) — DONE 29 Aug except email + Google
NOTE: the real domain is THElistinglab.app (found during setup, 29 Aug).
Apex + www both live and serving the Worker; workers.dev kept as backup.
- [x] Kyle: Cloudflare dashboard → Add a domain → thelistinglab.app → Free plan.
- [x] Kyle: GoDaddy → thelistinglab.app → Nameservers → the two Cloudflare ones.
      **Auto-renew ON.**
- [x] Cloudflare "Active" 29 Aug.
- [x] Assistant: attach custom domain to the Worker (Settings → Domains &
      Routes, or `[[routes]]` block already stubbed at the bottom of
      wrangler.toml). Add www → apex redirect.
- [x] Assistant: SITE_URL in wrangler.toml → https://thelistinglab.app; redeploy.
      (SITE_URL drives Stripe return links, OAuth redirect, container callback.)
- [x] Assistant: og:image / twitter:image URLs in web/index.html → thelistinglab.app.
- [x] Assistant: Cloudflare Email Routing — support@thelistinglab.app →
      ksremedia@gmail.com. LIVE 29 Aug (destination auto-verified — it is the
      Cloudflare account email; no click needed). Test email
      sent and received in gmail 29 Aug — CONFIRMED WORKING.
- [x] Kyle (29 Aug): Google console → the Listing Lab OAuth client →
      Authorized redirect URIs → ADD `https://thelistinglab.app/api/auth/google/callback`
      (keep the workers.dev one too).
- [x] Kyle (29 Aug): OAuth consent screen — branding completed (privacy/terms
      links, authorized domain) and app published: **In production**.
      (otherwise only listed test users can use Google sign-in).

## 2. Stripe live mode (Kyle sends key, assistant flips)
- [x] Kyle: live secret key delivered 29 Aug.
- [x] Assistant: STRIPE_SECRET_KEY live key installed 29 Aug.
- [x] Assistant: live webhook registered (we_1U9pQZ77vHJ6toR8lYhXBnVD) on
      https://thelistinglab.app/api/stripe/webhook; STRIPE_WEBHOOK_SECRET set.
- [x] DONE 29 Aug: real 10-pack purchase, $19.99 succeeded
      (pi_3U9qO377vHJ6toR8...), webhook fired, balance +10 confirmed by Kyle.
      No refund by design — first revenue. LIVE STRIPE LOOP CLOSED.

## 3. The wipe (LAST, on Kyle's explicit go)
- [x] WIPE EXECUTED 29 Aug on Kyle's go: preview eyeballed (2 matches),
      goldenrun+…@ksremedia.com + buycheck@example.com deleted with cascade;
      verified: 2 real accounts remain (kyle@horizonhomemedia.com,
      horizonhomemedia508@gmail.com) with their own history. Kyle chose to
      KEEP his accounts' test history/dev credits (founder-history-zero.sql
      written but not run — his call, cosmetic only).
      (Rehearsed 28 Aug 2026 against the real schema: test accounts cascade
      away, a real customer account survives. Kyle's own sign-ins use his real
      email and are NOT matched — check the SELECT anyway.)

## 4. Smoke test on the real domain (assistant, ~15 min)
- [ ] Landing loads over https://thelistinglab.app; icons, marquee, hero rotator.
- [ ] Fresh signup with email+password; Google sign-in; signout/signin.
- [ ] Upload → twilight (1 credit) → delivered → download is a real .jpg →
      Save to Photos sheet appears on iOS.
- [ ] Buy the 10-pack with a real card (then refund) — balance moves.
- [ ] Promo: mint a 1-credit code on /internal/board/promos, redeem it, see the
      redeemer named on the list.
- [ ] Report a problem from the result screen; see it on /internal/board/reports.
- [ ] Dashboard numbers: revenue matches the one real purchase; AI cost is the
      measured number, not the estimate.

## 5. Announce (Kyle)
- [ ] Facebook post. The link preview uses web/social-card.jpg (before/after of
      his own waterfront listing). First-five commenters → DM each a single-use
      promo code minted on the promo screen.

## Rollbacks
- Any bad deploy: `git log --oneline` → check out the last good version of the
  file(s) and redeploy; or Cloudflare dashboard → Workers → Deployments →
  Rollback. Both take about a minute.
- Emergencies without a rollback: the two dashboard kill switches (pause sales,
  pause generation) stop money and spend instantly with honest customer copy.
