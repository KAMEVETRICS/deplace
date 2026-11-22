# Web app redesign: D place structure, Concordium Wallet colours

Approved in conversation on 22 Nov 2026.

## Intent

Deplace's web app looks generic (system font, blue accent, pill badges). It should look like a finished product of the same family as the user's D place (deplace.space): same structure, type and motif, but in the colours of Concordium Wallet for Web, the wallet Deplace users sign with.

## Approaches

- **Restyle in place (picked).** Keep React 18 + Vite, hash routing and all logic; replace `web/src/styles.css` and the page markup. Cheapest, and nothing a user sees would differ from the alternatives.
- Port to Next.js like D place. Rejected: a rewrite for no visible gain.
- Share one CSS package between the two repos. Rejected: couples two projects for one stylesheet.

## From D place (structure, type, motif)

- Fraunces (display: headings, wordmark, stamp, amounts) and Source Sans 3 (UI), self-hosted with `@fontsource-variable/*` (no Google request).
- A small rectangular **D** stamp beside the wordmark "Deplace". 8px radius on cards, fields and buttons; 2px on the stamp; buttons are not pills; flat surfaces.
- Shell: sidebar on desktop (>= 960px) with brand and nav (Board, Post; You: My record), a top bar with greeting and account chip, a bottom dock on phones.
- Components: page head with back icon button, badge, kicker, card ("ticket"), price, banner, field, well, ledger.

## Colours (sampled from the wallet screenshot)

| Role | D place had | Deplace uses |
|---|---|---|
| Page | paper `#F3E6C8` | `#131416` |
| Cards, tiles, dock | cream `#FFF8EA` | `#212426` |
| Wells, active nav | `#E7D7B0` | `#383A3C` |
| Lines | `#8A7350` | `#4B5357` |
| Text | ink `#1A1714` | `#FFFFFF` |
| Secondary text | `#5C5348` | `#959EA3` |
| Secondary values, kicker | (stamp) | `#B6C9DC` |
| Money (amounts, Fund / Pay / Accept) | gold `#C8920A` | the balance gradient `#A8D6CA` -> `#D5C8B1` -> `#968DCF` |
| Identity mark (D stamp) | stamp `#7A1F2B` | Concordium blue `#2667FF` |
| Errors, final rejection, unpaid | stamp `#7A1F2B` | added soft red `#F07A82` (solid `#C93C47`) |

Dark only, like the wallet (replaces the current light/dark pair). No paper grain.

## What stays

All behaviour, routes, API calls and copy meaning. Texts the tests rely on stay: "Escrowed (custodial)", "Not funded" with its promise title, "Accepted, unpaid", and the fee notice as `role="alert"`.

## Non-goals

No new features, no logo work beyond the stamp, no light theme.

## Done when

Board, bounty page, post form and profile render in the new style at desktop and phone widths; web tests and typecheck pass; a short `web/DESIGN.md` records the system.
