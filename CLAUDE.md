# Building SAH Elite Performance — for Claude Code & any build tool

**Read `MANIFESTO.md` (product north star) and `App-Spec.md` (esp. §10 architecture) before building.** Build to that vision and those guardrails. This file is safe to be public — no personal data lives here.

## How to work
- **Ask before you assume.** Before multi-step work or any design fork, surface clear options and confirm; don't guess scope. Confirm before anything destructive (deletes, history rewrites, force-push).
- **Concise, plain English.** Explain what you changed and *why*, simply — the owner delegates and approves; he is not a developer.
- **One tested step at a time.** Keep the app working at each step; preview on iPhone.
- **Privacy first.** Never commit secrets (`.env`, `service_role` keys) or personal/health data to the repo.

## Architecture guardrails (non-negotiable — full detail in App-Spec.md §10)
Program is data, not code · stable immutable session IDs · planned vs performed kept separate · snapshot the prescription on completion · forward-only plan edits (`planVersion`) · reserve `athleteId` / `planId` (default `self`/`current`) · all storage via `db.js` · keep export/import JSON working.

## Personal context
The owner's private context (situation, goals, constraints) is intentionally **not in this repo**. It lives locally in `CLAUDE.local.md` (gitignored) and/or `~/.claude/CLAUDE.md`. Ask if you need it.
