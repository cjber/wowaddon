# AGENTS.md

wowaddon is a CLI and terminal UI that finds, installs and updates WoW addons from GitHub,
CurseForge, WoWInterface, Tukui and Wago Addons into a WoW: Classic Era or WoW: Forever AddOns folder, driven
by a small per-flavor text manifest. It fully replaces WowUp: search and browse match the addon
websites as far as each source's API allows, and `adopt` takes over what WowUp installed.

## Commands

```sh
bun install --frozen-lockfile
bun run start      # run the app (TUI when stdin and stdout are a terminal)
bun run check      # typecheck + lint + test
bun run gate       # check + host build + changelog + project rules: what CI runs
bun run build      # standalone binary for this machine in dist/; `all` builds x64 and arm64
bun run typecheck
bun run lint
bun test
python3 .sloppatrol/gate.py --base origin/main && python3 .sloppatrol/agents.py check
```

CI runs the same gate, builds and smoke-tests the x64 and arm64 binaries (each natively on its own runner;
a local cross build first needs `bun install --os linux --cpu "*"` for the other OpenTUI native package), and runs actionlint, zizmor and gitleaks.
Releases: `bun scripts/release.ts patch|minor|major` on a branch, merge, then `bun scripts/release.ts tag` on the
merged `main` commit and push the tag; `.github/workflows/release.yml` publishes the GitHub release with binaries and the CHANGELOG entry.

## Layout

- `src/types.ts`: shared contracts (`Flavor`, `Entry`, `Row`, `Context`, ...).
- `src/service.ts`: the only API the CLI and TUI call: `openContext`, `listRows`,
  `addAddon`, `syncAddons`, `removeAddon`, `parseRef`, `findAddons`, `addonInfo`,
  `listCategories`, `listUntracked`, `adoptAddons`, and the background update checks
  (`startBackgroundChecks`, `updateNotice`, `runBackgroundChecks`, from `src/background.ts`). Everything else (sources, install,
  backup, state, config, manifest, refs, http) is an implementation detail behind it.
- `src/sources/` installs from each source; `src/discover/` searches, browses and describes
  addons, one file per source plus `src/discover/index.ts`, which merges results and holds `sourceNotes`, the
  per-source parity notes that help, schema and the README repeat. `src/text.ts` turns HTML,
  BBCode and Markdown descriptions into plain text.
- `src/adopt.ts` matches untracked AddOns folders to sources; `src/wowup.ts` reads WowUp's
  addon records, read only.
- `src/cli.ts`: `runCli(argv)`; returns an exit code, or `undefined` to hand off to the TUI. Its
  `specs` table is the one source for argument parsing, `--help` and `wowaddon schema`; a new
  command or flag goes there. The `--json` envelope and exit codes are a documented contract:
  a change that removes or redefines a field bumps `SCHEMA_VERSION` and goes in the CHANGELOG.
- `skills/wowaddon/SKILL.md`: the agent skill shipped to users; keep it in step with the CLI.
- `src/tui/`: the terminal UI. `src/tui/model.ts` and `src/tui/browse.ts` (the browse view) hold
  pure state transitions and are unit-tested directly; `src/tui/App.tsx` renders it, `src/tui/useAddons.ts` manages async actions, and
  `src/tui/keymap.ts` handles keys.
- `src/testing/`: offline fixtures (injected `fetch`, fixture zips) shared by the tests.

## Rules

- Tests are offline only. `fetch` is injected via `setFetch()` in `src/http.ts`; an unexpected
  real network call is a test failure, not a skip.
- Never touch an addon folder that is a symlink, contains `.git`, or sits inside a git
  worktree: skip it and say why. That is what keeps this repo's own addons live during
  development.
- `sync` snapshots the flavor's `WTF` folder before its first change and changes nothing if the
  snapshot fails. Tests keep `HOME` and the state directory inside a scratch dir.
- `--dry-run` and `check` never take the lock or write the manifest, state or AddOns folder.
- Secrets (GitHub token, optional CurseForge key, Wago Addons key) come from env vars, `~/.config/wowaddon/`
  token files, or `gh auth token`: never written into the user’s config.json, the manifest or state
  files.
- A GitHub token goes only to `api.github.com`; a CurseForge key only to
  `api.curseforge.com`; a Wago key only to `addons.wago.io`. Never to a download host.
- The TUI's views share one frame with fixed heights, so switching views never moves a line;
  `App.test.tsx` checks it. Keep that when adding a view or a pane.
- Commits are signed (`git commit -S`) with the personal email.
- Quality: load `.agents/skills/sloppatrol-project/SKILL.md` before cleanup, dead-code or refactoring
  work.
