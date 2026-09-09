# Lab Owner — your private Listing Lab back-office app

What it is: the owner pages you already use in Safari (Live, Board, Promos), as an app on your phone, plus an alert when a job is refused or fails. Never published. Nobody else can open it — it asks for the owner secret once and keeps it in the phone's Keychain.

## Put it on your phone (about 10 minutes, same steps as the Horizon app)

1. Unzip this folder somewhere on your Mac (next to `~/Desktop/iosapp/horizonhomemedia` is fine).
2. Double-click **LabOwner.xcodeproj**. Xcode opens it.
3. In the left sidebar click the blue **LabOwner** project icon → the **LabOwner** target → **Signing & Capabilities**. Under **Team**, pick your Apple developer team (the same one as the Horizon app). If Xcode complains the bundle ID is taken, change `com.horizonhomemedia.labowner` to anything unique — it never leaves your account.
4. Plug in your iPhone (or pick it under Devices), then press the **Run** ▶ button. First time only: on the phone go to Settings → General → VPN & Device Management and trust your developer profile. That's enough to use it — the app stays on your phone for a week at a time on a free-style install, or indefinitely with a paid developer account.
5. For TestFlight instead (so it never expires): **Product → Archive**, then **Distribute App → TestFlight & App Store → Upload**. In App Store Connect add the app to your internal testers (just you). You are NOT submitting for review — TestFlight internal testing needs no review.

## First launch

It asks for the owner secret — the `s=` value from your board link (`…/internal/board?s=THIS_PART`). Paste it, tap **Open the board**. It checks the secret against the site before keeping it. Then allow notifications when asked.

## What the alerts do (honest version)

- While the app is open: checks the live feed every minute.
- In the background: iOS runs the check on its own schedule — typically every 15 minutes to a couple of hours, more often for apps you open regularly, never when Low Power Mode is on. So a refused job may reach you a while later, not instantly. Instant push would need a server-side change; say the word if you want that later.
- It buzzes for **refused** and **failed** jobs. There's a switch on the Alerts tab to also buzz for deliveries.
- The first check after installing only learns what's already there, so you don't get a pile of old alerts.

## If something's off

- "That secret didn't open the board": the secret changed or has a typo. It's the same one that works in Safari.
- Blank page in a tab: pull the reload arrow (top right). The pages are the live site, so if the site is down, so is the tab.
- To start over: Alerts tab → **Forget the secret**.
