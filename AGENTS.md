# AGENTS.md

wowaddon is a CLI and terminal UI that installs and updates WoW addons from GitHub,
CurseForge and WoWInterface into a WoW: Classic Era or WoW: Forever AddOns folder, driven
by a small per-flavor text manifest.

## Commands

```sh
bun install --frozen-lockfile
bun run check      # typecheck + lint + test
bun run typecheck
bun run lint
bun test
```

The same gate CI runs, plus actionlint, zizmor and gitleaks on the workflows and history.

## Layout

- `src/types.ts` — the frozen contracts (`Flavor`, `Entry`, `Row`, `Context`, ...). Anyone
  changing them appends a `CHANGE:` line to `src/CONTRACTS.md` first.
- `src/service.ts` — the only API the CLI and TUI call: `openContext`, `listRows`,
  `addAddon`, `syncAddons`, `removeAddon`, `parseRef`. Everything else (sources, install,
  state, config, manifest, refs, http) is an implementation detail behind it.
- `src/cli.ts` — `runCli(argv)`; returns an exit code, or `undefined` to hand off to the TUI.
- `src/tui/` — the terminal UI. `model.ts` holds pure state transitions and is unit-tested
  directly; `App.tsx` is the thin React view over it.
- `src/testing/` — offline fixtures (injected `fetch`, fixture zips) shared by the tests.

## Rules

- Tests are offline only. `fetch` is injected via `setFetch()` in `http.ts`; an unexpected
  real network call is a test failure, not a skip.
- Never touch an addon folder that is a symlink, contains `.git`, or sits inside a git
  worktree — skip it and say why. That is what keeps this repo's own addons live during
  development.
- `service.ts` is the only surface the CLI and TUI use for state or network. Neither reaches
  into `sources/`, `install.ts` or `state.ts` directly.
- Secrets (GitHub token, optional CurseForge key) come from env vars, `~/.config/wowaddon/`
  token files, or `gh auth token` — never written into `config.json`, the manifest or state
  files.
- A GitHub token goes only to `api.github.com`; a CurseForge key only to
  `api.curseforge.com`. Never to a download host.
- Commits are signed (`git commit -S`) with the personal email.
- Quality: load `.agents/skills/sift-project/SKILL.md` before cleanup, dead-code or
  refactoring work.

## Standards

None yet specific to this repo beyond the commands above.
