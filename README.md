# wowaddon

CLI and terminal UI for managing WoW addons from GitHub, CurseForge, WoWInterface, Tukui and
Wago Addons. One manifest per flavor, no CurseForge API key, JSON output and a schema for coding
agents, and a small keyboard-driven TUI for anyone who would rather not remember the flags.

## Install

Each release has standalone Linux binaries, `wowaddon-linux-x64` and `wowaddon-linux-arm64`, that need nothing else:

```sh
gh release download -R cjber/wowaddon -p wowaddon-linux-x64 -O ~/.local/bin/wowaddon
chmod +x ~/.local/bin/wowaddon
```

To run from source instead, you need [Bun](https://bun.sh).

```sh
git clone git@github.com:cjber/wowaddon.git
cd wowaddon
bun install
ln -sf "$PWD/bin/wowaddon" ~/.local/bin/wowaddon
```

## Usage

```sh
wowaddon                               # TUI in a terminal, otherwise sync
wowaddon sync [<id|ref>...] [--adopt] [--dry-run] [--no-backup]
wowaddon check [<id|ref>...]           # what sync would install or update
wowaddon add <ref|url> [--note TEXT] [--no-install] [--adopt] [--dry-run]
wowaddon add <kind> <ref> [--note TEXT] [--no-install] [--adopt] [--dry-run]
wowaddon remove <id|ref> [--dry-run]
wowaddon list [--refresh]
wowaddon schema                        # commands, flags, JSON shapes and exit codes as JSON
```

Global options: `--flavor era|forever`, `--addons-dir PATH`, `--json`, `-h/--help`, `-V/--version`.

Output is plain lines to stdout, progress to stderr: `OK cf:6124 Auctionator 11.0.3`,
`SKIP gh:a/b dev link, skipped`, `FAIL gh:a/b <message>`. `--dry-run` resolves the latest
releases and reports what would change, but downloads nothing and leaves the manifest, state and
AddOns folder as they are.

| Exit code | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| `0`       | done; dev-link skips count as success                   |
| `1`       | an addon or the operation failed                        |
| `2`       | usage or configuration error                            |
| `3`       | another wowaddon run holds this flavor's lock, so retry |
| `130`     | cancelled with Ctrl+C                                   |

### TUI

Runs when both stdin and stdout are a terminal and no subcommand is given.

| Key              | Action                                                   |
| ---------------- | -------------------------------------------------------- |
| `↑`/`k`, `↓`/`j` | move the selection                                       |
| `u`              | update the selected addon, or take over an unmanaged one |
| `U`              | update everything                                        |
| `a`              | add an addon — paste a ref or URL, `Enter` installs      |
| `x`              | remove the selected addon (`y` to confirm)               |
| `f`              | cycle flavor (era / forever)                             |
| `r`              | refresh latest versions                                  |
| `?`              | help                                                     |
| `q`, `Ctrl+C`    | quit                                                     |

No borders, no colour overrides beyond the terminal's own dim/bold — it should look like it
belongs on your machine, not like a dashboard.

## Flavors

`era` (Classic Era, `_classic_era_`) and `forever` (WoW: Forever, `_forever_`,
Interface 16001). `--flavor` and the TUI's `f` key switch between them; each has its own
manifest and installed-state file.

## Sources

| kind    | ref                | from                                                                        |
| ------- | ------------------ | --------------------------------------------------------------------------- |
| `gh`    | `OWNER/REPO`       | newest compatible GitHub release, or the source archive if none ships a zip |
| `cf`    | numeric id or slug | CurseForge, no API key needed                                               |
| `wowi`  | file id            | WoWInterface                                                                |
| `tukui` | `elvui` or `tukui` | the Tukui API; ElvUI's one ZIP loads on both Classic Era and Forever        |
| `wago`  | project slug       | Wago Addons, with a personal API key                                        |

`add` also accepts a pasted URL: a `github.com/OWNER/REPO` link, a
`curseforge.com/wow/addons/<slug>` link (with or without `/files/<id>`), or a
`wowinterface.com/downloads/...` link, a `tukui.org/<slug>` link or an
`addons.wago.io/addons/<slug>` link. A bare name such as `elvui` also finds the manifest entry
with that ref. CurseForge works without a key by reading its public
files listing; set `CF_API_KEY`/`CURSEFORGE_API_KEY` (or `~/.config/wowaddon/cf_token`) only
if that stops working for you.

A GitHub token avoids the 60/hour anonymous API limit: `GH_TOKEN`/`GITHUB_TOKEN`,
`~/.config/wowaddon/token`, or `gh auth token`. It is sent only to `api.github.com`, never to
a download host.

Wago Addons only serves its API to supporters: the personal key is part of the Wago Addons
Supporter tier on [Patreon](https://www.patreon.com/wagoio) (see
[addons.wago.io/patreon](https://addons.wago.io/patreon)). Set `WAGO_ADDONS_API_KEY` or write the
key to `~/.config/wowaddon/wago_token`. It is sent only to `addons.wago.io`. Without one, a
`wago` addon fails with `WAGO_KEY_MISSING` and everything else syncs as usual.

## Manifest and config

State lives under `${XDG_CONFIG_HOME:-~/.config}/wowaddon/`:

- `config.json` (optional): `{ "defaultFlavor": "era", "addonsDir": { "era": "...", "forever": "..." }, "backupKeep": 5 }`
- `era.txt` / `forever.txt`: one `kind ref  # note` per line (see `addons.example.txt`)
- `state/<flavor>.json`: installed versions and owned folders, written atomically
- `cache/cf-slugs.json`: CurseForge slug-to-id cache

A pre-existing `addons.txt` is copied to `era.txt` the first time `era.txt` is missing; the
original is left alone and wowaddon says so once.

The AddOns folder is resolved in order: `--addons-dir`, `WOW_ADDONS` (era only, for
compatibility with the old script), `config.json`, the default Steam/Proton path if it
exists, then a search under `~/Games/*` and Steam's `compatdata`. An ambiguous or missing
result is a config error (exit `2`) with the paths it found or how to set one.

## WTF backups

Before `sync` changes anything, it snapshots the flavor's `WTF` folder (the sibling of
`Interface`, holding settings and SavedVariables) to
`${XDG_STATE_HOME:-~/.local/state}/wowaddon/backups/<flavor>/WTF-<timestamp>.zip`. It keeps the
newest `backupKeep` archives (default 5; `0` turns backups off), and `--no-backup` skips one run.
A sync with nothing to change takes no snapshot. If the snapshot fails, sync changes nothing and
reports `BACKUP_FAILED` on each addon it would have installed.

## Dev-link safety

An addon folder that is a symlink, contains `.git`, or sits inside a git worktree is never
touched: sync skips it and says why, and `remove` stops tracking it (manifest line and
state entry) while the folder stays as it is. That is how this repo's own addons under active
development stay live while everything else updates normally. A folder installed outside
wowaddon is left alone too, unless you pass `--adopt` (or confirm the TUI's take-over
prompt), after which it will be replaced like any other managed folder.

Before an addon is first installed, its dev link is found by name (the GitHub repo name or the
Tukui or Wago slug, ignoring case and punctuation, so `questie/questietrace` matches
`QuestieTrace`) or by the CurseForge or WoWInterface project ID in the folder's TOC, and it shows
as `dev`, not `missing`.

## Agents and scripting

Every command is safe for cron, a shell alias or a coding agent: no prompts and real exit codes.
With `--json` each run prints exactly one JSON document on stdout and keeps progress on stderr:

```json
{ "schemaVersion": 1, "command": "check", "flavor": "forever", "addonsDir": "...", "updates": 1, "addons": [Row] }
```

A row is `{ entry, installed?, latest?, status, message?, code? }`, where `status` is one of
`missing`, `update`, `current`, `unknown`, `dev`, `unmanaged` or `error`, and `code` is the typed
error code on a failed row. A failed command prints `{ schemaVersion, command, error: { code,
message } }` instead. `wowaddon schema` describes every command, flag, output shape, status, error
code and exit code. The agent skill at [`skills/wowaddon/SKILL.md`](skills/wowaddon/SKILL.md)
says how an agent should drive it.

## Development

```sh
bun install --frozen-lockfile
bun run check   # typecheck + lint + test
```

Tests are offline: `fetch` is injected, and an unexpected network call fails the test.
