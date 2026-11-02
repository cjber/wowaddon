# About the app

wowaddon is a command line tool and terminal UI that installs and updates World of Warcraft addons from
GitHub, CurseForge, WoWInterface, Tukui and Wago Addons, from a per-flavor text manifest. Subcommands:
`sync`, `add`, `remove`, `list`, `check`, `schema`, plus `--help` and `--version`. Output lines are
`OK`, `SKIP` or `FAIL`; exit codes are 0 ok, 1 an addon failed, 2 usage or config error.

## How to run it, always in a sandbox

Never run it against the real install. Make a throwaway home and config once per session, then prefix
every command with those three variables:

```sh
mkdir -p /tmp/wa-run/config/wowaddon /tmp/wa-run/home /tmp/wa-run/state /tmp/wa-run/AddOns
printf '{"defaultFlavor":"forever","addonsDir":{"forever":"/tmp/wa-run/AddOns"}}' \
  > /tmp/wa-run/config/wowaddon/config.json
: > /tmp/wa-run/config/wowaddon/forever.txt

HOME=/tmp/wa-run/home XDG_CONFIG_HOME=/tmp/wa-run/config XDG_STATE_HOME=/tmp/wa-run/state \
  bun src/index.tsx list --json
```

`bun src/index.tsx` is the entry point (`bin/wowaddon` is a shell wrapper, so do not hand it to bun).
Because `HOME` points at the sandbox, the manifest, the state file and the WTF backups are all
throwaway, and a `sync` cannot touch the user's game.

## Sign in

No sign-in. A GitHub token would come from `gh auth token`, but do not use the network: keep to commands
that read and write only the sandbox.

## Important flows

- `--help`, `--version`, `schema --json`, an unknown subcommand, a malformed manifest line.
- `list` and `list --json` on an empty manifest, and on one with a valid and an invalid entry.
- `check` on the same manifest: it must report and install nothing.
- `add` then `list` then `remove` against the sandbox manifest, if you can do it without the network.

## Never do these things

- Never run a command without the sandbox `HOME`, `XDG_CONFIG_HOME` and `XDG_STATE_HOME`.
- Never launch the game, Battle.net, Lutris or Wine.
- Never edit, move or delete files.
- Never use the network.
