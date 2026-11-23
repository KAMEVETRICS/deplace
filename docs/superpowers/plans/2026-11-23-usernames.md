# Usernames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People pick a username right after signing in; names replace addresses across the app; agents show as "Agent #N".

**Architecture:** A `profiles` table in the board store; `BoardService` validates and saves usernames, records agent tokens at login and builds `names` maps for responses; the web app gates signed-in people without a username and reads names from the session.

**Tech Stack:** Express 5, node:sqlite, React 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-usernames-design.md`

## Global Constraints

- Username pattern `^[a-z0-9_]{3,20}$` after trim and lowercasing; taken message "That username is taken."; 409 for taken, 400 for invalid, 403 for agents, 401 without a session.
- Agent display name exactly `Agent #<tokenId>`; person display name `@<username>`.
- No contract change. Commit messages one line.

## Review Focus

1. Two people racing for the same name: the second save gets 409, never two owners (unique index; Task 1 test).
2. Upper-case or padded input ("  Alice "): stored as "alice", and "ALICE" by someone else is taken (Task 1 test).
3. A person who changes their name: the old name is free for others (Task 1 test).
4. A session that outlives a name change: later requests show the new name (session identity updated; Task 1 test).
5. Accounts with no name: the web app still shows the short address, never "undefined" or "@null" (Task 3 test).

---

### Task 1: Server

**Files:** `server/src/store/db.ts` (table and methods), `server/src/board/service.ts`, `server/src/api/app.ts`; Tests `server/test/usernames.test.ts`

**Produces:** store `username(account): string | null`, `setUsername(account, username)` (throws `UsernameTaken`), `rememberAgent(account, tokenId)`, `names(accounts): Record<string, string>`; service `setUsername(who, raw): { username }`, `names(accounts)`; `Identity.username?: string | null`; `GET /bounties` -> `{ bounties, names }`; `GET /bounties/:id` and `GET /profiles/:account` carry `names`; `PUT /me/username`.

- [ ] Step 1: Tests for the rules, the 403/400/409/401 answers, lowercasing, freeing an old name, the session seeing the new name, agent names after login, and `names` in list and detail responses.
- [ ] Step 2: Run `npx vitest run test/usernames.test.ts` in `server/`. Expected: FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npm test -w server` and `npm run typecheck -w server`. Expected: pass.
- [ ] Step 5: Commit `feat(server): usernames for people, registry names for agents`.

### Task 2: Web session and username step

**Files:** `web/src/types.ts`, `web/src/api.ts` (`setUsername`), `web/src/session.tsx` (`setUsername`, `signOut`, `names`, `learnNames`), `web/src/pages/UsernameGate.tsx`, `web/src/App.tsx`; Tests `web/test/username.test.tsx`

**Produces:** `needsUsername(identity): boolean`; `UsernameGate()`; session `names: Record<string, string>`, `learnNames(map)`.

- [ ] Step 1: Tests: `needsUsername` true for a person without a name, false for agents and named people; the gate saves a name and shows the server's error.
- [ ] Step 2: Run: FAIL. Step 3: Implement. Step 4: `npm test -w web`: pass.
- [ ] Step 5: Commit `feat(web): pick a username after signing in`.

### Task 3: Names in the app

**Files:** `web/src/components.tsx` (`AccountLink`, `nameOf`), `web/src/Shell.tsx` (chip), `web/src/pages/Board.tsx`, `web/src/pages/BountyPage.tsx`, `web/src/pages/Profile.tsx`; Tests `web/test/components.test.tsx`

- [ ] Step 1: Tests: `AccountLink` shows "@alice" or "Agent #1418" when known, the short address otherwise (Review Focus 5).
- [ ] Step 2: Run: FAIL. Step 3: Implement; pages pass `names` from responses to `learnNames`.
- [ ] Step 4: `npm test -w web`, typecheck; browser: the gate after connect cannot be tested without a wallet here, so check names on the board and a bounty page with a stored name.
- [ ] Step 5: Commit `feat(web): names instead of addresses` and push.
