# Building SAH Elite Performance — for Claude Code & any build tool

**Read `MANIFESTO.md` (product north star) and `App-Spec.md` (esp. §10 architecture) before building.** Build to that vision and those guardrails. This file is safe to be public — no personal data lives here.

## How to work
- **Ask before you assume.** Before multi-step work or any design fork, surface clear options and confirm; don't guess scope. Confirm before anything destructive (deletes, history rewrites, force-push).
- **Concise, plain English.** Explain what you changed and *why*, simply — the owner delegates and approves; he is not a developer.
- **One tested step at a time.** Keep the app working at each step; preview on iPhone.
- **Privacy first.** Never commit secrets (`.env`, `service_role` keys) or personal/health data to the repo.

## Architecture guardrails (non-negotiable — full detail in App-Spec.md §10)
Program is data, not code · stable immutable session IDs · planned vs performed kept separate · snapshot the prescription on completion · forward-only plan edits (`planVersion`) · reserve `athleteId` / `planId` (default `self`/`current`) · all storage via `db.js` · keep export/import JSON working.

## UI invariants
- Calendar day cells stay square regardless of month start weekday; place the 1st with `grid-column-start`, never empty filler cells; keep `min-width:0` on `.cal-cell`. Covered by `tests/calendar-grid.test.js`.

## Build-in-public capture
The app build feeds the content brand — the build is also the story. **Every session ends by capturing what it shipped.** This is a standing ritual, not a one-off:
1. Append a dated entry to `BUILD-LOG.md` (in this repo) in plain English a non-coder can read, in this shape: **SHIPPED** (what now works that didn't, in human terms — not "refactored sync.js" but "the app now warns you before overwriting a session from another device") · **BROKE / GOT HARD** (the honest dead-end or confusing part) · **THE SURPRISE** (the one non-obvious thing — usually the best post) · **BY THE NUMBERS** (real receipts: tests, %, files, features).
2. Draft 2–3 short build-in-public posts in Sam's voice and **append** (don't overwrite) to `Content-Buffer/Build-Log-Drafts.md` in the private content folder outside this repo (`../SAS Solutions/Personal Brand & Social/`). Load the voice from that folder's `Brand-Kit/Voice-Doc.md` §7; each post = standalone hook, one idea, a real receipt, no selling.

Keep it honest and **private-safe**: never post secrets, exact address/suburb, or specific medical detail (keep figures in bands). Full system: `../SAS Solutions/Personal Brand & Social/Build-in-Public-Engine.md`.

## Personal context
The owner's private context (situation, goals, constraints) is intentionally **not in this repo**. It lives locally in `CLAUDE.local.md` (gitignored) and/or `~/.claude/CLAUDE.md`. Ask if you need it.
