# Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A landing page for hackathon judges at `#/` whose animated hero shows an agent doing a bounty, with "Open the board" taking them to the board at `#/board`.

**Architecture:** Pure timeline and stats functions drive a React hero (CSS for motion, a clock hook for time); the landing has its own frame and stylesheet; App routes `#/` to it and the board to `#/board`.

**Tech Stack:** React 18.3.1, Vite 8.3.8, Vitest + Testing Library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-22-landing-page-design.md`

## Global Constraints

- Agent copy is the real flow: badge `JyP9WVTtVnRuL8JUmLKZH`, "Agent #1418", bounty #1, 1 EUDemo, escrow payout.
- Loop about 12 s; `prefers-reduced-motion: reduce` renders the finished state with no movement.
- Wallet palette and Fraunces / Source Sans 3 from `styles.css`; money in the gradient; the agent's cursor and selection in Concordium blue; text blue on dark at least 4.5:1 (`#6B9BFF`).
- Our own SVG sketches only; no third-party artwork. No new dependencies. Commit messages one line.

## Review Focus

1. Screen readers on the landing: the moving text is hidden from them and a static sentence says what the animation shows (Task 2 test).
2. Reduced motion: no clock runs, the hero shows Paid with all five lines (Task 2 test).
3. Phone width 375px: the giant word, terminal and card stack without sideways scroll; the cursor is hidden (Task 3 browser check).
4. Old links: `#/` used to be the board; every in-app "back to the board" now goes to `#/board` (Task 3 grep and test).
5. Board API down: the landing still renders, counts show "–" instead of failing (Task 2 test).

---

### Task 1: Timeline and stats

**Files:** Create `web/src/landing/timeline.ts`; Test `web/test/landing.test.tsx`

**Interfaces — Produces:**
- `STEPS: { at: number; line: string; status: "Open" | "Claimed" | "Submitted" | "Paid" }[]` (5 steps), `LOOP_MS = 12000`, `WORDS = ["Deplace", "Bounty"]`, `SKETCHES = 4`
- `frameAt(t: number): { lines: number; typed: number; status; word: string; sketch: number; cursorOnCard: boolean }` (t is wrapped by `LOOP_MS`; `typed` = characters shown of the newest line at 30 ms per character)
- `FINAL: ReturnType<typeof frameAt>` (all lines, fully typed, Paid)
- `boardStats(bounties: Bounty[]): { posted: number; paid: number; paidUnits: bigint }`

- [ ] Step 1: Tests `frameAt starts with one line and an Open bounty`, `frameAt reaches Claimed, Submitted and Paid in order and loops`, `frameAt types the newest line`, `FINAL shows every line, fully typed, Paid`, `boardStats counts posted, paid and the EUDemo paid out`.
- [ ] Step 2: Run `npx vitest run test/landing.test.tsx` in `web/`. Expected: FAIL (module missing).
- [ ] Step 3: Implement.
- [ ] Step 4: Run again. Expected: PASS.
- [ ] Step 5: Commit `feat(web): landing timeline and board stats`.

### Task 2: Landing page

**Files:** Create `web/src/pages/Landing.tsx`, `web/src/landing/Sketch.tsx` (`Sketch({ index }: { index: number })`: 4 line drawings, `pathLength="1"` for the draw-in), `web/src/landing/landing.css`, `web/src/landing/links.ts` (repo, e2e run, agent badge URLs); Test `web/test/landing.test.tsx`

**Interfaces — Consumes:** Task 1 exports; `api.bounties`, `useSession().config`, `Amount`, `formatAmount`. **Produces:** `Landing()`.

- [ ] Step 1: Tests `every Open the board link goes to #/board`, `tells screen readers what the animation shows and hides the moving text`, `shows the finished state when the visitor prefers reduced motion` (mock `matchMedia`), `still renders when the board API fails` (counts "–").
- [ ] Step 2: Run. Expected: FAIL.
- [ ] Step 3: Implement (hero: giant word, sketch, terminal, card with selection box and cursor; below: counts, Concordium pieces, proof links, closing button).
- [ ] Step 4: Run `npm test -w web`. Expected: all pass.
- [ ] Step 5: Commit `feat(web): landing page with the agent at work`.

### Task 3: Routing and check

**Files:** Modify `web/src/App.tsx` (`#/` -> `Landing` without the shell, `#/board` -> board), `web/src/Shell.tsx` (nav Board `#/board`, brand `#/`), `web/src/pages/BountyPage.tsx` (back to `#/board`), `web/DESIGN.md` (motion lives on the landing only); Test `web/test/shell.test.tsx`

- [ ] Step 1: Test `links Board to #/board and the brand to the landing page`. Run: FAIL.
- [ ] Step 2: Implement; `grep -rn 'href="#/"' web/src` shows only brand links.
- [ ] Step 3: `npm test -w web` and `npm run typecheck -w web`: pass.
- [ ] Step 4: Browser: landing at 1280 and 375 (Review Focus 3), the loop runs, "Open the board" opens the board, back from a bounty returns to the board.
- [ ] Step 5: Commit `feat(web): landing at #/, board at #/board` and push.
