# About the app

wowaddon is a Bun and TypeScript CLI and TUI that installs and updates WoW addons from a per-flavor
manifest. `bun src/index.tsx` is the entry point; `bin/wowaddon` is only a shell wrapper around it.

- Keep a change only when it speeds up the CLI or TUI itself, or the gate. A change to a test or to the
  benchmark definition is not a speed-up.
- Every change must pass `bun run typecheck`, `bun run lint` and `bun test`, which is what CI runs.
- `src/service.ts` is the only API the CLI and the TUI call; a speed-up that bypasses it is a
  refactor in disguise and has to say so.
- Never point a command at a real AddOns folder: use a throwaway `HOME` and `XDG_CONFIG_HOME` as
  `.bugpatrol/instructions.md` describes.
- Never use the network.
