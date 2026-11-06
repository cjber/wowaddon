# About the code

wowaddon is a Bun and TypeScript CLI and TUI for managing WoW addons. `src/service.ts` is the only API
the CLI and the TUI call; `src/types.ts` holds the shared contracts (`Flavor`, `Entry`, `Row`,
`Context`). `bin/wowaddon` is a shell wrapper around `src/index.tsx`.

- Keep the public surface as it is: command names, flags, the `--json` shapes, and the `schema` output
  are contracts other agents read. A refactor that changes one is a feature, not a refactor.
- `bun test` is the oracle, and `bun run typecheck` and `bun run lint` have to stay green: biome formats
  markdown too, so a hand-edited doc can fail the gate.
- Never point a command at a real AddOns folder: use a throwaway `HOME` and `XDG_CONFIG_HOME`.
- Never use the network.

## Conventions

- Errors cross module boundaries as `WowaddonError(code, message)` (`src/types.ts`); a bare
  `catch {}` rethrows a `WowaddonError` with a code, or carries a comment saying why it drops it.
- Network goes through `requestJson` / `requestBytes` in `src/http.ts`; tests swap `fetch` with
  `setFetch()` and never touch the network.
- TUI state transitions are pure functions in `src/tui/model.ts`; side effects live in
  `src/tui/useAddons.ts`.
- `src/testing/fixtures/` holds recorded public API responses: never edit them in a cleanup.

## Settled

- Comment-only `catch` blocks: anonymous GitHub access when `gh auth token` fails (`src/http.ts`),
  and the TUI's background refresh keeping the last rows (`src/tui/useAddons.ts`).
