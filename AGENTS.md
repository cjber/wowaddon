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
python3 .sift/gate.py --base origin/main && python3 .sift/agents.py check
```

CI runs the same gate, plus actionlint, zizmor and gitleaks on the workflows and history.

## Layout

- `src/types.ts` — shared contracts (`Flavor`, `Entry`, `Row`, `Context`, ...).
- `src/service.ts` — the only API the CLI and TUI call: `openContext`, `listRows`,
  `addAddon`, `syncAddons`, `removeAddon`, `parseRef`. Everything else (sources, install,
  state, config, manifest, refs, http) is an implementation detail behind it.
- `src/cli.ts` — `runCli(argv)`; returns an exit code, or `undefined` to hand off to the TUI.
- `src/tui/` — the terminal UI. `src/tui/model.ts` holds pure state transitions and is unit-tested
  directly; `src/tui/App.tsx` renders it, `src/tui/useAddons.ts` manages async actions, and
  `src/tui/keymap.ts` handles keys.
- `src/testing/` — offline fixtures (injected `fetch`, fixture zips) shared by the tests.

## Rules

- Tests are offline only. `fetch` is injected via `setFetch()` in `src/http.ts`; an unexpected
  real network call is a test failure, not a skip.
- Never touch an addon folder that is a symlink, contains `.git`, or sits inside a git
  worktree — skip it and say why. That is what keeps this repo's own addons live during
  development.
- `src/service.ts` is the only surface the CLI and TUI use for state or network. Neither reaches
  into `src/sources/`, `src/install.ts` or `src/state.ts` directly.
- Secrets (GitHub token, optional CurseForge key) come from env vars, `~/.config/wowaddon/`
  token files, or `gh auth token` — never written into the user’s config.json, the manifest or state
  files.
- A GitHub token goes only to `api.github.com`; a CurseForge key only to
  `api.curseforge.com`. Never to a download host.
- Commits are signed (`git commit -S`) with the personal email.
- Quality: load `.agents/skills/sift-project/SKILL.md` before cleanup, dead-code or refactoring
  work.

## Standards

None yet specific to this repo beyond the commands above.
