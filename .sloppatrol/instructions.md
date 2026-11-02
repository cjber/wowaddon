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
