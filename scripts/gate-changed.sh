#!/usr/bin/env bash
# The fast local gate for the branch: typecheck, Biome over the changed files (committed, staged, unstaged and
# untracked) and the tests that change reaches. `bun run gate` is the full set CI runs.
set -euo pipefail
cd "$(dirname "$0")/.."

committed="$(git diff --name-only --diff-filter=d origin/main)"
untracked="$(git ls-files --others --exclude-standard)"
mapfile -t files < <(printf '%s\n%s\n' "$committed" "$untracked" | sort -u | sed '/^$/d')

bun x tsc --noEmit
if [ "${#files[@]}" -gt 0 ]; then
  bun x biome check --no-errors-on-unmatched "${files[@]}"
fi
bun test --changed=origin/main
