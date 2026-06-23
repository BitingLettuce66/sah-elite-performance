# Running several Claude sessions at once (git worktrees)

If you run two Claude Code sessions in the **same folder**, they fight over it:
both share one "current branch", so one session quietly switches the branch out
from under the other, and commits land on the wrong branch. (That's exactly what
happened once — a calendar fix landed on the design branch.)

**Git worktrees** fix this. A worktree is a second folder that shares the same
project history but has its **own checked-out branch**. Each Claude session gets
its own folder, so they can run in parallel and never collide.

```
Training-App/                      ← main folder (usually on main)
Training-App-worktrees/
  design-styleguide/               ← session A, branch design/styleguide
  ui-calendar-polish/              ← session B, branch ui/calendar-polish
  feat-ai-coach/                   ← session C, branch feat/ai-coach
```

All of them share one `.git`, so there's only ever one copy of the history — no
re-cloning, and pushing/pulling works from any of them.

## The three commands

Run these from the **main** `Training-App` folder:

```bash
# Start a new parallel workspace (creates the branch off main + a folder for it)
scripts/wt.sh new feat/ai-coach

# See everything you have open
scripts/wt.sh list

# Tidy up when a piece of work is merged (deletes the folder, keeps the branch)
scripts/wt.sh rm feat/ai-coach
```

`new` also accepts a starting point if you don't want `main`:
`scripts/wt.sh new fix/thing some-other-branch`. If the branch already exists it
just opens a folder for it instead of creating it.

## The everyday flow

1. In the main folder: `scripts/wt.sh new <branch>`
2. It prints a path. **Open a new terminal**, `cd` into that path, and run `claude`.
3. Work as normal — commit, push, open a PR from inside that folder.
4. When the PR is merged: back in the main folder, `scripts/wt.sh rm <branch>`.

Each Claude session stays in **its own folder for its whole task.** Don't point
two sessions at the same folder.

## What the helper sets up for you

A brand-new worktree only contains files that are committed to git, so it would
normally be missing the things git ignores. The helper symlinks those from the
main folder so the new workspace runs immediately:

- **`node_modules/`** — so you don't wait for a fresh `npm install`.
- **`.env`** and other local config (`CLAUDE.local.md`, `App-Spec.md`, …) — so
  the app and your private context behave the same everywhere.

Because `node_modules` is *shared* via that symlink, all worktrees use the same
installed packages. That's what you want 99% of the time. The one exception: if a
branch **changes dependencies** (edits `package.json`), run a real install just
for that worktree so it doesn't disturb the others:

```bash
rm node_modules            # remove the shared symlink in THIS worktree only
npm install                # give this worktree its own packages
```

## Good to know

- One branch can only be checked out in **one** worktree at a time — git will
  refuse a second, which is the safety net working as intended.
- Deleting a worktree folder by hand leaves git confused; use `scripts/wt.sh rm`
  (or `git worktree prune` to clean up after a manual delete).
- The `Training-App-worktrees/` folder lives *next to* the repo, not inside it,
  so it never shows up in `git status`.
