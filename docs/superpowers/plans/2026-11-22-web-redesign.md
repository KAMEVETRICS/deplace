# Web App Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `web/` with D place's structure, type and stamp in Concordium Wallet colours, without changing behaviour.

**Architecture:** One token-based stylesheet (`web/src/styles.css`) holds the whole system; a `Shell` component gives the sidebar / top bar / dock layout; shared bits (`Icon`, badges, `Amount`, `Banner`) live in `components.tsx` and `icons.tsx`; pages only swap markup and class names.

**Tech Stack:** React 18.3.1, Vite 8.3.8, Vitest + Testing Library, `@fontsource-variable/fraunces` 5.3.0, `@fontsource-variable/source-sans-3` 5.3.1.

**Spec:** `docs/superpowers/specs/2026-11-22-web-redesign-design.md`

## Global Constraints

- Colours exactly as the spec's table: page `#131416`, surface `#212426`, well `#383A3C`, line `#4B5357`, text `#FFFFFF`, muted `#959EA3`, label `#B6C9DC`, money gradient `#A8D6CA -> #D5C8B1 -> #968DCF`, stamp `#2667FF`, danger `#F07A82` / solid `#C93C47`.
- Dark only. No grain. 8px radius (2px stamp), buttons not pills.
- Fonts self-hosted; no request to Google.
- Texts the tests use stay: "Escrowed (custodial)", "Not funded" + promise title, "Accepted, unpaid", fee notice `role="alert"`.
- No behaviour, route or API change. Commit messages one line.

## Review Focus

1. A 50-character account address or 64-hex hash in a card or meta line at 375px width: wraps, no horizontal page scroll (`overflow-wrap: anywhere`; checked in Task 4 at phone width).
2. A browser without `background-clip: text`: amounts still readable (solid `#D5C8B1` declared before the gradient; Task 1 CSS).
3. Keyboard focus on dark surfaces: every link and button shows a visible ring (`:focus-visible` 3px `#B6C9DC`; Task 4 tab-through check).
4. Phone width: the dock never covers the last content row (main gets bottom padding of dock height; Task 4 check).
5. Busy state: disabled buttons look disabled on dark (opacity 0.55, `cursor: progress`; Task 3 test asserts `disabled` stays wired).

---

### Task 1: Foundation (fonts, tokens, base and component styles, icon)

**Files:**
- Modify: `web/package.json` (add the two font packages, exact versions)
- Modify: `web/src/main.tsx` (import both fonts before `styles.css`)
- Rewrite: `web/src/styles.css`
- Create: `web/public/icon.svg` (D stamp: `#131416` ground, `#2667FF` 2px-style outline and Fraunces-like serif D)
- Modify: `web/index.html` (icon link, `theme-color` `#131416`)

**Interfaces:**
- Produces CSS classes later tasks use: `.shell .side .top .dock .main .brand .stamp .wordmark .nav-label .userchip .avatar .icon-btn .btn (.money .ghost .danger) .card .ticket .card-body .card-foot .badge (.funded .promise .ok .danger .quiet) .kicker .price (.big) .meta .banner (.ok .err .fund) .field .well .ledger .page-head .tabs .stats .stat .grid.two .stack .stack.tight .row .muted`.

- [ ] Step 1: `npm install -w web @fontsource-variable/fraunces@5.3.0 @fontsource-variable/source-sans-3@5.3.1 --save-exact`
- [ ] Step 2: Write the stylesheet: `:root` tokens from Global Constraints; `.price` sets `color: #D5C8B1` then the gradient with `background-clip: text`; `.btn.money` uses the gradient as background with `#131416` text.
- [ ] Step 3: Run `npm test -w web` and `npm run typecheck -w web`. Expected: 6 passed, no type errors.
- [ ] Step 4: Commit `feat(web): wallet-colour design tokens and D place type`.

### Task 2: Shell

**Files:**
- Create: `web/src/icons.tsx` — `Icon({ name, size? }: { name: IconName; size?: number })`, `IconName = "board" | "post" | "me" | "wallet" | "back" | "out" | "link"`, stroke paths from D place's `ui.tsx` set.
- Create: `web/src/Shell.tsx` — `Shell(props: { route: "board" | "post" | "me" | "other"; account: string | null; label: string | null; busy: boolean; onConnect(): void; children: ReactNode })`.
- Modify: `web/src/App.tsx` (route to `Shell`; toast rendered as `Banner` inside main; custodial note as `.meta` at the end of main).
- Test: `web/test/shell.test.tsx`

**Interfaces:**
- Consumes: Task 1 classes.
- Produces: `Shell`, `Icon`, `IconName`.

- [ ] Step 1: Write the failing tests: `renders the D stamp and wordmark`, `marks the current page in the nav with aria-current="page"` (route "post" -> the Post link), `shows Connect wallet when signed out and the short account when signed in` (`short()` of the account, label text).
- [ ] Step 2: Run `npx vitest run test/shell.test.tsx` in `web/`. Expected: FAIL (module not found).
- [ ] Step 3: Implement `Icon`, `Shell` and wire `App`.
- [ ] Step 4: Run `npm test -w web`. Expected: all pass.
- [ ] Step 5: Commit `feat(web): D place shell with sidebar, top bar and dock`.

### Task 3: Shared components

**Files:**
- Modify: `web/src/components.tsx` — `FundingBadge` (classes `badge funded` / `badge promise`, same text and titles), `KindBadge` -> `<span className="kicker">`, `StatusPill` (class `badge` plus `ok` for Paid, `danger` for AcceptedUnpaid / RejectedFinal / NoAward, `quiet` for Expired / Cancelled / Refunded), new `Amount({ units, decimals, token, big? })`, new `Banner({ kind, children })` with `kind: "ok" | "err" | "info" | "fund"`, `FeeNotice` as a `fund` banner with `role="alert"`.
- Test: `web/test/components.test.tsx`

- [ ] Step 1: Add failing tests: `StatusPill marks Paid ok and Rejected (final) danger` (class names), `Amount shows the formatted amount and token` (`2500000`, 6 -> "2.5 EUDemo").
- [ ] Step 2: Run them. Expected: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npm test -w web`. Expected: all pass, including the 6 existing.
- [ ] Step 5: Commit `feat(web): badges, amount and banner in the new style`.

### Task 4: Pages

**Files:**
- Modify: `web/src/pages/Board.tsx` (page head with h1 + lede + Post button, `.tabs` filters with `aria-selected`, cards as `.card.ticket` in `.grid.two`)
- Modify: `web/src/pages/BountyPage.tsx` (page head with back `icon-btn`; badge row, h1, "Posted by", `Amount big`, meta; sections as `.card`; `btn money` for Fund / Pay on delivery / Accept, `btn` for Claim / Submit / Enter / Award, `btn danger` for Reject / Cancel; timeline as `.ledger`)
- Modify: `web/src/pages/PostBounty.tsx` (`.field` labels, `form.stack`), `web/src/pages/Profile.tsx` (`.stats` of `.stat` cards, numbers in Fraunces)
- Create: `web/DESIGN.md` (the system in D place's DESIGN.md format, with this palette)

- [ ] Step 1: Rewrite the markup page by page; behaviour untouched.
- [ ] Step 2: Run `npm test -w web` and `npm run typecheck -w web`. Expected: all pass.
- [ ] Step 3: In the browser pane against the running board: screenshot board, a bounty, post form and a profile at desktop width and at 375px; check Review Focus 1, 3 and 4.
- [ ] Step 4: Commit `feat(web): board, bounty, post and profile in the new design` and push.
