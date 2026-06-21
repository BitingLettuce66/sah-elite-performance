#!/usr/bin/env bash
# ship.sh — land the current feature branch as ONE clean PR onto the base branch.
#
# One feature = one branch = many commits = one PR. This rebases the branch onto the
# latest base (so the merge is always clean, even if main moved), runs the test gate,
# pushes, and opens (or updates) exactly one PR. It deliberately avoids stacked PRs
# that target each other — those break on branch auto-delete during merge. See
# CONTRIBUTING.md.
#
# Usage:  npm run ship            # base = main
#         npm run ship -- <base>  # ship onto a different base
set -euo pipefail

BASE="${1:-main}"
branch="$(git symbolic-ref --quiet --short HEAD || true)"

[ -z "$branch" ] && { echo "✗ Detached HEAD — switch to a feature branch first."; exit 1; }
[ "$branch" = "$BASE" ] && { echo "✗ Refusing to ship from '$BASE' itself. Work on a feature branch."; exit 1; }
[ -n "$(git status --porcelain)" ] && { echo "✗ Working tree not clean — commit or stash first."; exit 1; }

echo "→ Fetching origin/$BASE …"
git fetch origin "$BASE"

echo "→ Rebasing $branch onto origin/$BASE …"
if ! git rebase "origin/$BASE"; then
  echo "✗ Conflicts. Resolve them, then: git rebase --continue && npm run ship"
  exit 1
fi

echo "→ Running tests …"
npm test

echo "→ Pushing $branch …"
git push --force-with-lease -u origin "$branch"

if gh pr view "$branch" --json state --jq .state >/dev/null 2>&1; then
  echo "✓ PR already open for $branch — updated. View: gh pr view --web"
else
  gh pr create --base "$BASE" --head "$branch" --fill
fi

echo "✓ Shipped '$branch' → '$BASE' as a single PR."
echo "  Merge it with:  gh pr merge --merge --delete-branch"
