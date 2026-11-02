# wowaddon

CLI and terminal UI for managing WoW addons from GitHub, CurseForge and WoWInterface. One
manifest per flavor, no CurseForge API key, and a small keyboard-driven TUI for anyone who
would rather not remember the flags.

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
wowaddon sync [<id|ref>...] [--adopt]
wowaddon add <ref|url> [--note TEXT] [--no-install] [--adopt]
wowaddon add <kind> <ref> [--note TEXT] [--no-install] [--adopt]
wowaddon remove <id|ref>
wowaddon list [--refresh] [--json]
```

Global options: `--flavor era|forever`, `--addons-dir PATH`, `-h/--help`, `-V/--version`.

Output is plain lines to stdout, progress to stderr: `OK cf:6124 Auctionator 11.0.3`,
`SKIP gh:a/b dev link, skipped`, `FAIL gh:a/b <message>`. Exit codes: `0` on success (dev-link
skips count as success), `1` on any failed addon, `2` on a usage or config error, `130` on
Ctrl+C.

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

| kind   | ref                | from                                                                        |
| ------ | ------------------ | --------------------------------------------------------------------------- |
| `gh`   | `OWNER/REPO`       | newest compatible GitHub release, or the source archive if none ships a zip |
| `cf`   | numeric id or slug | CurseForge, no API key needed                                               |
| `wowi` | file id            | WoWInterface                                                                |

`add` also accepts a pasted URL: a `github.com/OWNER/REPO` link, a
`curseforge.com/wow/addons/<slug>` link (with or without `/files/<id>`), or a
`wowinterface.com/downloads/...` link. CurseForge works without a key by reading its public
files listing; set `CF_API_KEY`/`CURSEFORGE_API_KEY` (or `~/.config/wowaddon/cf_token`) only
if that stops working for you.

A GitHub token avoids the 60/hour anonymous API limit: `GH_TOKEN`/`GITHUB_TOKEN`,
`~/.config/wowaddon/token`, or `gh auth token`. It is sent only to `api.github.com`, never to
a download host.

## Manifest and config

State lives under `${XDG_CONFIG_HOME:-~/.config}/wowaddon/`:

- `config.json` (optional) — `{ "defaultFlavor": "era", "addonsDir": { "era": "...", "forever": "..." } }`
- `era.txt` / `forever.txt` — one `kind ref  # note` per line (see `addons.example.txt`)
- `state/<flavor>.json` — installed versions and owned folders, written atomically
- `cache/cf-slugs.json` — CurseForge slug-to-id cache

A pre-existing `addons.txt` is copied to `era.txt` the first time `era.txt` is missing; the
original is left alone and wowaddon says so once.

The AddOns folder is resolved in order: `--addons-dir`, `WOW_ADDONS` (era only, for
compatibility with the old script), `config.json`, the default Steam/Proton path if it
exists, then a search under `~/Games/*` and Steam's `compatdata`. An ambiguous or missing
result is a config error (exit `2`) with the paths it found or how to set one.

## Dev-link safety

An addon folder that is a symlink, contains `.git`, or sits inside a git worktree is never
touched — sync skips it and says why, and `remove` stops tracking it (manifest line and
state entry) while the folder stays as it is. That is how this repo's own addons under active
development stay live while everything else updates normally. A folder installed outside
wowaddon is left alone too, unless you pass `--adopt` (or confirm the TUI's take-over
prompt), after which it will be replaced like any other managed folder.

## Scripting

`sync` and `add` are safe for cron or a shell alias: no prompts, plain stdout, real exit
codes. `list --json` gives the full row data (entry, installed, latest, status) for anything
else you want to build on top.

## Development

```sh
bun install --frozen-lockfile
bun run check   # typecheck + lint + test
```

Tests are offline: `fetch` is injected, and an unexpected network call fails the test.
