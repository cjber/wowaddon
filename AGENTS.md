# AGENTS.md

wowaddon is a CLI and terminal UI (Bun, TypeScript) that finds, installs and updates WoW addons from GitHub,
CurseForge, WoWInterface, Tukui and Wago Addons into a WoW: Classic Era or WoW: Forever AddOns folder, driven by
a per-flavor text manifest. It fully replaces WowUp; `adopt` takes over what WowUp installed.

## Commands

```sh
bun install --frozen-lockfile
bun run gate:changed   # fast: typecheck, biome and the tests the branch reaches (diff against origin/main)
bun run gate           # typecheck + lint + test + host build + changelog check: what CI runs
bun run start          # run the app (TUI when stdin and stdout are a terminal)
```

Release: `bun scripts/release.ts patch|minor|major` on a branch, merge, then `bun scripts/release.ts tag` on the
merged `main` commit and push the tag; `release.yml` publishes the binaries and the CHANGELOG entry. A local cross
build needs `bun install --os linux --cpu "*"` for the other OpenTUI native package.

## Layout

- `src/service.ts` is the only API the CLI and TUI call; sources, install, backup, state, config, manifest, refs
  and http are details behind it. `src/types.ts` holds the shared contracts.
- `src/cli.ts`: its `specs` table is the one source for argument parsing, `--help` and `wowaddon schema`; a new
  command or flag goes there. The `--json` envelope and exit codes are a contract: removing or redefining a field
  bumps `SCHEMA_VERSION` and goes in the CHANGELOG.
- `src/discover/index.ts` holds `sourceNotes`, the per-source parity notes that help, schema and the README repeat.
- `skills/wowaddon/SKILL.md` is the skill shipped to users: keep it in step with the CLI.
- `src/tui/model.ts` and `browse.ts` hold pure, directly tested state transitions; `App.tsx` renders them.

## Invariants

- Tests are offline: `fetch` is injected with `setFetch()` in `src/http.ts`; a real network call fails the test.
  Tests keep `HOME` and the state directory in a scratch dir.
- Never touch an addon folder that is a symlink, contains `.git`, or sits inside a git worktree: skip it and say
  why. That keeps the dev addons live.
- `sync` snapshots the flavor's `WTF` folder before its first change and changes nothing if the snapshot fails.
  `--dry-run` and `check` never take the lock or write the manifest, state or AddOns folder.
- Secrets come from env vars, token files under `~/.config/wowaddon/` or `gh auth token`, and are never written to
  config, manifest or state. A GitHub token goes only to `api.github.com`, a CurseForge key to `api.curseforge.com`,
  a Wago key to `addons.wago.io`, never to a download host.
- The TUI views share one frame with fixed heights, so switching views never moves a line (`App.test.tsx`).
- Commits are signed (`git commit -S`) with the personal email (`cjberragan@gmail.com`).
- Read `.sloppatrol/instructions.md` before cleanup, dead-code or refactoring work.

## Standards

- `repo-standards`: the RS-* requirements every cjber and agent-labs-dev repo meets; its `audit.py` checks this repo.
