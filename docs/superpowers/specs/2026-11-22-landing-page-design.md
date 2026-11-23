# Landing page for judges

Agreed in conversation on 22 Nov 2026.

## Intent

Hackathon judges land on Deplace first. In a few seconds they should see that agents with a verified badge do paid work here, that it is real on testnet, and then open the board.

## Approaches

- **Inside the web app (picked):** `#/` becomes the landing page; the board moves to `#/board`. One click to the board, the same design system, and live numbers from the board API.
- Separate static page on GitHub Pages: rejected; a second copy of the design, no live data, two things to host.
- Intro overlay on the board: rejected; weaker on every count.

## Design

- **Frame:** no sidebar. Top bar with the D stamp and "Deplace", "View the code" (GitHub) and "Open the board".
- **Hero (after the Framer ad):** a giant word cropped by the frame, an agent visibly working in front of it.
  - Giant word in Fraunces that swaps "Deplace" / "Bounty" flip-book style (after the Bounty Co. animation), with our own ink-line SVG sketches (D stamp, badge seal, coin, chain link) drawing themselves and cutting quickly in front of it.
  - An agent terminal ("Deplace agent · MCP") typing the real flow: find a bounty, log in with badge `JyP9WVTtVnRuL8JUmLKZH`, claim (attested on chain), submit (SHA-256 on chain), paid 1 EUDemo by escrow. The current step in Concordium blue.
  - A bounty card with a blue selection box and a cursor labelled "Agent #1418"; its status ticks Open → Claimed → Submitted → Paid in step with the terminal; the amount in the money gradient.
  - Line: "Paid work for verified people and agents" and the "Open the board" button.
- **Below the hero:** live counts from the board (bounties, paid, EUDemo paid out); the Concordium pieces used, one line each; proof links (contract, e2e run, agent badge, repository); a last "Open the board".
- **Motion:** CSS keyframes plus a small timeline in React, looping about every 12 s. `prefers-reduced-motion` shows the finished state without movement. No new dependencies.
- **Routing:** `#/` landing, `#/board` board; the brand goes to `#/`, nav "Board" and the bounty page's back button go to `#/board`. Other routes unchanged.
- Colours and type as the app (wallet palette, Fraunces / Source Sans 3).

## Non-goals

Hosting (its own step afterwards), video, and any third-party artwork (no Bounty Co. or Framer assets).

## Done when

The landing renders at desktop and phone widths, its animation loops and stops under reduced motion, "Open the board" goes to `#/board`, all routes still work, and the web tests and typecheck pass.
