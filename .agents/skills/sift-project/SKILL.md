---

name: sift-project
description: "Project skill for sift in wowaddon: the exact quality-gate and evidence commands, live roots that must never be deleted as dead code, exclusions, conventions and risk order. Load before running sift or any code-quality, cleanup or dead-code work in this repository."
---

# sift project skill: wowaddon

<!-- Written by `sift setup`. Keep it factual: every command here has been run and works.
     Update it whenever an audit learns something (a live root, a false-positive source). -->

wowaddon is a Bun + TypeScript (strict) CLI and OpenTUI React terminal UI that installs and updates
WoW addons from GitHub, CurseForge and WoWInterface into a Classic Era or WoW: Forever AddOns folder.
It runs locally through `bin/wowaddon` (a bash launcher that execs `bun src/index.tsx`); it is not
published as a package.

## Gate

Run in order from the repository root. All must pass (exit 0) before and after any audit slice.

```sh
bun install --frozen-lockfile
bun run check                               # tsc --noEmit, biome check ., bun test (208 tests, offline)
python3 .sift/gate.py --base origin/main    # project rules
python3 .sift/agents.py check
```

ast-grep pin: not needed while `.sift/rules/` is empty.

## Evidence

On-demand tools for audits, run through `bunx` without adding dependencies. Output is candidates,
never verdicts.

```sh
bunx knip                                   # knip 6.38.0; exits 1 while it reports anything
bunx jscpd src --reporters console          # jscpd 5.3.2
```

Known false positives:

- knip: "unused exports" that are used inside their own file (`expandHome`, `redact`,
  `recoverPending`, `Status`, `Phase`, `Mode`, `DetectedRef` at setup). Dropping `export` is the
  candidate fix, never deleting the symbol.
- knip: `bin/wowaddon` is a bash script it cannot parse; `src/index.tsx` is reached through the
  `start` script, so knip does not report either as unused. Neither is dead.
- knip / tsc: OpenTUI JSX intrinsic elements (`<box>`, `<text>`, ...) come from
  `jsxImportSource: @opentui/react`, not from React DOM.
- jscpd: all 8 clones at setup are test setup/teardown boilerplate in `*.test.ts(x)`.
- `src/testing/` is imported only by tests; that is its job, not dead code.

## Live roots

- `package.json` `bin` -> `bin/wowaddon` -> `src/index.tsx` -> `runCli`, then a dynamic
  `import("./tui/run")` for the TUI.
- `src/service.ts`: the only API the CLI and TUI call; its exports are the internal public surface.
- Persisted formats read back from disk: `config.json`, the per-flavor manifests (`addons.txt`,
  `era.txt`) and `state/<flavor>.json` under the config dir. Field names and schema checks there are
  compatibility, not dead code.
- `src/flavors.ts`: tokens and interface ranges matched against user input and `.toc` files.

## Model-read text

None.

## Zones

| Path                                                       | Zone    | Reason                                                 |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------ |
| `src/**/*.test.ts`, `src/**/*.test.tsx`                    | test    | colocated `bun test` specs                             |
| `src/testing/helpers.ts`                                   | test    | offline `fetch` stubs and zip builders shared by tests |
| `src/testing/fixtures/`                                    | fixture | recorded public API responses; never edited by cleanup |
| `bin/`                                                     | script  | launcher                                               |
| `.github/`, `biome.json`, `tsconfig.json`, `.editorconfig` | config  |                                                        |
| `README.md`, `CHANGELOG.md`, `addons.example.txt`          | docs    |                                                        |
| `.sift/gate.py`, `.sift/agents.py`, `.sift/LICENSE`        | vendor  | copied byte for byte from sift                         |

## Conventions

- Errors cross module boundaries as `WowaddonError(code, message)` (`src/types.ts`); a bare
  `catch {}` rethrows a `WowaddonError` with a code, or carries a comment saying why it drops it.
- Network goes through `requestJson` / `requestBytes` in `src/http.ts`; tests swap `fetch` with
  `setFetch()` and never touch the network.
- TUI state transitions are pure functions in `src/tui/model.ts`; side effects live in
  `src/tui/useAddons.ts`.
- Biome formatting: 2 spaces, width 100, double quotes; imports organised by Biome.

## Risk order

1. `src/testing/`, `src/*.test.ts`: test plumbing.
2. `src/tui/`: presentation and key handling.
3. `src/cli.ts`, `src/refs.ts`, `src/toc.ts`, `src/flavors.ts`, `src/manifest.ts`.
4. `src/sources/`: remote API parsing.
5. `src/service.ts`, `src/config.ts`, `src/state.ts`.
6. `src/http.ts`, `src/install.ts`, `src/archive.ts`: credentials, downloads and writes to the
   AddOns folder (symlink / `.git` / worktree protection).

## Settled

- Comment-only `catch` blocks (silent-fallbacks): anonymous GitHub access when `gh auth token`
  fails, e.g. `src/http.ts`; the TUI's background refresh keeping the last rows,
  `src/tui/useAddons.ts`.

## Anti-patterns

## Project rules and lenses

- Rules already owned elsewhere: `tsc --noEmit` (strict), Biome `recommended` preset, offline tests
  (`offline()` in `src/testing/helpers.ts` fails any unexpected fetch).
- ast-grep rules: `.sift/rules/` (0): none yet.
- Script rules: `.sift/scripts/` (0): none yet.
- Lenses: `.sift/lenses/`: none yet.
