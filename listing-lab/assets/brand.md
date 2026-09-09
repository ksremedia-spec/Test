# Listing Lab — brand and design tokens

Taken verbatim from `backend/web/app.html` and `backend/web/index.html`. The full design-system notes (buttons, cards, badges, spacing rhythm, where each token is used) are in `docs/APP-SCREENS.md` §4. This file is the quick reference.

## Colours

The app is dark, always. Two registers share one palette: the marketing/site register (`--paper…`) and the working "studio" register the app itself uses (`--studio-…`).

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#0F141B` | Site background, launch screen, app-icon ground |
| `--paper-2` | `#151C25` | Raised surfaces on the site |
| `--paper-3` | `#1B2431` | Inputs, deeper surfaces |
| `--ink` | `#E9EDF3` | Primary text |
| `--ink-soft` | `#A6B1BF` | Secondary text |
| `--ink-faint` | `#75818F` | Tertiary text, hints |
| `--pine` | `#4E8FD0` | **Brand accent** — primary buttons, ticks, links, active states |
| `--pine-bright` | `#66A2DE` | Accent hover / pressed / emphasis |
| `--pine-deep` | `#14304F` | The compliance band ground |
| `--brass` | `#8FBEE8` | Secondary accent (eyebrows in the band, "working" badge) |
| `--brass-soft` | `#C9DFF2` | Light secondary |
| `--terracotta` | `#E17A5C` | Rejected / attention (rare) |
| `--line` | `#2A3545` | Borders on the site |
| `--studio-bg` | `#0C1118` | App background |
| `--studio-surface` | `#131A24` | App cards |
| `--studio-surface-2` | `#19222E` | App raised surfaces (photo cards, sheets) |
| `--studio-surface-3` | `#1F2938` | App inputs, thumbnails' empty ground |
| `--studio-line` | `#293546` | App borders |
| `--studio-text` | `#E9EDF3` | App primary text |
| `--studio-text-soft` | `#A0ABBA` | App secondary text |
| `--studio-text-faint` | `#6B7787` | App hints, the "AI can make mistakes" line |
| `--ok` | `#46B98A` | Delivered / success (badge text `#5ECD96`) |
| `--warn` | `#D9A441` | Warning |
| `--bad` | `#E2615A` | Failed / returned (badge text `#E08A8A`) |

Gradient used for the "Lab" in the wordmark and for one italic keyword on headings:
`linear-gradient(105deg, #5CC7F0 0%, #7FA8EC 45%, #8A7FE8 100%)`

Primary button: fill `--pine`, text `#0A1017` (near-black on blue), fully rounded (pill), 600 weight. Ghost button: transparent, 1px `--line` border, text `--ink`.

## Radii

`--r-sm` 6px · `--r-md` 10px (cards, inputs) · `--r-lg` 18px (sheets) · `--r-xl` 28px (bands).

## Type

- Display / headings: **Fraunces**, weights 400–700, italic for the gradient keyword. OFL licence (`fonts/OFL.txt`). The static TTFs for every weight the site uses are in `assets/fonts/` — bundle those (`Fraunces-400/500/600/700.ttf` and the 400/500/600 italics). Fallback: Iowan Old Style, Georgia.
- UI / body: the web uses **Inter**; on iOS use the **system font (SF)** — don't bundle Inter.
- Eyebrow labels: 0.72rem, letter-spacing .16em, uppercase, 600, colour `--pine`.
- Body 16–17px, line-height 1.55–1.6.

## Logo

- `logo/logo-source-1254.png` — the mark, 1254×1254, the highest-resolution copy that exists (the owner supplied it 28 Aug 2026). Camera outline in brand blue with a house, stars and an aperture inside, on white with rounded corners. **Make the App Store icon from this**: 1024×1024, the mark centered at ~72% width on `#0F141B`, no white plate, no alpha.
- `logo/logo-full-192.png` — the 192px copy the site's nav uses (with transparency).
- `icons/icon-512.png`, `icon-192.png`, `apple-touch-icon-180.png`, `favicon-32.png` — the site's icons, same mark.
- Wordmark: "LISTING LAB" — heavy caps with wide tracking, "LAB" in the gradient. Rendered in text, not an image; see `.mark` in `app.html`.

## Imagery

`sample-photos/` are real Horizon Home Media listing frames and real Listing Lab outputs (the "after" ones carry the stamp). Use them for screenshots and previews — never a stock photo, never a mockup. Filenames say what they are (`bed1.occ` = occupied bedroom, `.declut` = decluttered, `.empty`, `.staged`, `ext.day/dusk` = exterior day/twilight, `kliv/kbed/koff` = a second house's living room / bedroom / office). `founder/kyle.jpg` and `kyle-face.jpg` are the owner's portrait (founder page only — never in the app UI).

`social-card.jpg` (1200×630) is the site's link preview.
