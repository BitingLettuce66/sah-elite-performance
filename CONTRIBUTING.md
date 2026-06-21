# Contributing — branching & PR flow

**One feature = one branch = one PR.** Even a big feature with many parts ships as a
single branch with several commits and **one** pull request into `main`. This keeps
review and merge simple and avoids the stacked-PR trap below.

## The flow

1. Branch off the latest `main`:
   ```sh
   git fetch origin && git switch -c feat/my-thing origin/main
   ```
2. Work in **small, self-contained commits** (each commit ideally green on its own).
   Multiple commits in one branch is good — it's the *PRs* we keep to one.
3. Ship it as a single PR:
   ```sh
   npm run ship          # rebase onto latest main → test → push → open ONE PR
   ```
   Then merge from the PR page (or `gh pr merge --merge --delete-branch`).

`npm run ship` (see `scripts/ship.sh`) **rebases your branch onto the latest
`origin/main` first**, so the merge is always clean and conflict-free even if `main`
moved while you worked. It runs the test gate before pushing, and opens (or updates)
exactly one PR.

## Don't stack PRs that target each other

It's tempting to split a large feature into PR #2 → PR #1 → `main`. **Don't.** When the
bottom PR merges with *delete branch on merge* (the default), GitHub **auto-closes**
every PR that targeted the deleted branch, and any PR that hadn't retargeted yet can
merge into a dead feature branch instead of `main`. The result is a half-merged mess.

**Instead:**
- Keep it one branch + one PR (commits give reviewers the granularity).
- If you genuinely need separate reviewable PRs, merge them **top-first by retargeting
  the top PR to `main`** (its branch already contains every lower commit), then close
  the rest — or just collapse to one branch and open a single PR.

## If you've already ended up with a tangled stack

Collapse it. The top branch already contains all the lower commits linearly:
```sh
git switch top-branch
git fetch origin
git rebase origin/main           # resolve once; the lower commits replay on top
npm run ship                     # one clean PR with all the commits
```
Then delete the orphaned branches.

## The merge rule

- Merge with a **merge commit** (`gh pr merge --merge`), not squash — squash rewrites
  SHAs and breaks any branch built on the originals.
- Delete the branch after merge.
- `main` is checked out in the primary worktree, so a local post-merge checkout may
  fail harmlessly — the merge + remote-branch delete still happen via the API.
