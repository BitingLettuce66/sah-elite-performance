#!/usr/bin/env bash
#
# wt.sh — git worktree helper for SAH Elite Performance.
#
# Run several Claude Code (or terminal) sessions in parallel, each in its OWN
# folder on its OWN branch, so they never fight over a single working directory.
# (Two sessions sharing one folder end up switching branches under each other
# and committing to the wrong branch — worktrees stop that completely.)
#
# Usage:
#   scripts/wt.sh new <branch> [base]   Create a worktree for <branch> (off <base>, default: main)
#   scripts/wt.sh list                  Show all active worktrees
#   scripts/wt.sh rm <branch>           Remove a worktree (the branch itself is kept)
#   scripts/wt.sh help                  Show this help
#
# Worktrees are created next to the repo, in:
#   ../<repo>-worktrees/<branch-with-slashes-as-dashes>
#
# Each new worktree gets node_modules + local config (.env, etc.) symlinked
# from the main checkout, so it's ready to `npm run dev` / `npm test` instantly
# without a fresh, slow `npm install`.
#
set -euo pipefail

# --- locate the primary (main) checkout, no matter where we're invoked from ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
# In a linked worktree, --show-toplevel is the worktree, not main. Resolve the
# real main checkout via the common git dir's parent so links always anchor there.
COMMON_GIT_DIR="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir)"
case "$COMMON_GIT_DIR" in
  */.git) MAIN_ROOT="$(dirname "$COMMON_GIT_DIR")" ;;
esac
REPO_NAME="$(basename "$MAIN_ROOT")"
TREES_DIR="$(cd "$MAIN_ROOT/.." && pwd)/${REPO_NAME}-worktrees"

# Files that are gitignored (so they're absent in a fresh worktree) but that the
# app needs at runtime. Symlinked from main so every worktree behaves identically.
LINK_FILES=(".env" ".env.local" "CLAUDE.local.md" "App-Spec.md" ".claude/settings.local.json")

usage() { awk 'NR>=3 && /^#/ {sub(/^# ?/,""); print; next} NR>=3 {exit}' "${BASH_SOURCE[0]}"; }
slug()  { printf '%s' "$1" | tr '/' '-'; }

link_into() {
  # Symlink node_modules + local config from main into the given worktree dir.
  local dest="$1" f
  if [ -d "$MAIN_ROOT/node_modules" ] && [ ! -e "$dest/node_modules" ]; then
    ln -s "$MAIN_ROOT/node_modules" "$dest/node_modules"
    echo "  linked node_modules"
  fi
  for f in "${LINK_FILES[@]}"; do
    if [ -e "$MAIN_ROOT/$f" ] && [ ! -e "$dest/$f" ]; then
      mkdir -p "$dest/$(dirname "$f")"
      ln -s "$MAIN_ROOT/$f" "$dest/$f"
      echo "  linked $f"
    fi
  done
}

cmd_new() {
  local branch="${1:-}" base="${2:-main}"
  [ -n "$branch" ] || { echo "usage: scripts/wt.sh new <branch> [base]" >&2; exit 2; }
  local dir="$TREES_DIR/$(slug "$branch")"
  mkdir -p "$TREES_DIR"
  if git -C "$MAIN_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "Branch '$branch' exists — checking it out into a new worktree…"
    git -C "$MAIN_ROOT" worktree add "$dir" "$branch"
  else
    echo "Creating branch '$branch' off '$base' in a new worktree…"
    git -C "$MAIN_ROOT" worktree add -b "$branch" "$dir" "$base"
  fi
  link_into "$dir"
  echo
  echo "✓ Ready. In a NEW terminal:"
  echo "    cd \"$dir\""
  echo "    claude"
}

cmd_rm() {
  local branch="${1:-}" force="${2:-}"
  [ -n "$branch" ] || { echo "usage: scripts/wt.sh rm <branch> [--force]" >&2; exit 2; }
  local dir="$TREES_DIR/$(slug "$branch")" f
  [ -d "$dir" ] || { echo "No worktree at: $dir" >&2; exit 1; }
  # The symlinks we created (node_modules + config) count as "untracked files",
  # which makes `git worktree remove` refuse. Clear our own symlinks first so a
  # clean worktree removes without --force (and we never delete the real targets).
  [ -L "$dir/node_modules" ] && rm "$dir/node_modules"
  for f in "${LINK_FILES[@]}"; do [ -L "$dir/$f" ] && rm "$dir/$f"; done
  if [ "$force" = "--force" ] || [ "$force" = "-f" ]; then
    git -C "$MAIN_ROOT" worktree remove --force "$dir"
  elif ! git -C "$MAIN_ROOT" worktree remove "$dir" 2>/dev/null; then
    echo "Worktree has other uncommitted/untracked files. Either commit them," >&2
    echo "or re-run to discard them:  scripts/wt.sh rm \"$branch\" --force" >&2
    exit 1
  fi
  echo "✓ Removed worktree: $dir"
  echo "  (branch '$branch' kept — delete with: git branch -d \"$branch\")"
}

case "${1:-help}" in
  new)        shift; cmd_new "$@" ;;
  list|ls)    git -C "$MAIN_ROOT" worktree list ;;
  rm|remove)  shift; cmd_rm "$@" ;;
  help|-h|--help) usage ;;
  *) echo "Unknown command: $1" >&2; echo; usage; exit 2 ;;
esac
