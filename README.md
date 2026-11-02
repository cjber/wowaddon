# wowaddon

A complete replacement for WowUp: find, install, update and remove WoW addons from GitHub,
CurseForge, WoWInterface, Tukui and Wago Addons, from the command line or a keyboard-driven TUI.
Search and browse cover the same ground as the addon websites, `adopt` takes over everything WowUp
(or anything else) installed, and every command has JSON output and a schema, so a coding agent
can go from search to an installed addon without scraping a web page. One manifest per flavor and
no CurseForge API key needed.

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
wowaddon search <words...> [--sort relevance|downloads|updated|name] [--category NAME]
wowaddon browse [popular|trending|updated|name] [--category NAME]
wowaddon info <ref|url>                # summary, authors, downloads, versions, links, changelog
wowaddon categories                    # category names that --category takes
wowaddon adopt [--dry-run] [--wowup PATH] [--no-wowup] [--no-backup]
wowaddon sync [<id|ref>...] [--adopt] [--dry-run] [--no-backup]
wowaddon check [<id|ref>...]           # what sync would install or update
wowaddon add <ref|url> [--note TEXT] [--no-install] [--adopt] [--dry-run]
wowaddon add <kind> <ref> [--note TEXT] [--no-install] [--adopt] [--dry-run]
wowaddon remove <id|ref> [--dry-run]
wowaddon list [--refresh]
wowaddon schema                        # commands, flags, JSON shapes and exit codes as JSON
```

`search` and `browse` also take `--source cf,gh,wowi,tukui`, `--limit N` (up to 50, default 20),
`--page N` and `--all-flavors`.

Global options: `--flavor era|forever`, `--addons-dir PATH`, `--json`, `-h/--help`, `-V/--version`.

Output is plain lines to stdout, progress to stderr: `OK cf:6124 Auctionator 11.0.3`,
`SKIP gh:a/b dev link, skipped: ...`, `FAIL gh:a/b <message>`. `--dry-run` on `add` and `sync`
downloads each release it would install and checks its folders, so it reports the status a real
run would give, such as `unmanaged`, but leaves the manifest, state and AddOns folder as they are.
An `add` stopped by an `unmanaged` folder leaves the manifest alone too, so rerunning it with
`--adopt` takes the folder over.

| Exit code | Meaning                                                 |
| --------- | ------------------------------------------------------- |
| `0`       | done; dev-link skips count as success                   |
| `1`       | an addon or the operation failed                        |
| `2`       | usage or configuration error                            |
| `3`       | another wowaddon run holds this flavor's lock, so retry |
| `130`     | cancelled with Ctrl+C                                   |

### TUI

Runs when both stdin and stdout are a terminal and no subcommand is given. `tab` switches between
the installed list and the browse view. Both share one frame, a header with the view, flavor and
position, the list, a detail pane, a status line and the keys line, so switching views never
moves a line, and each view keeps its own place.

| Key                                                     | Installed                                                | Browse                                 |
| ------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| `j`/`k`, `pgup`/`pgdn`, `ctrl-d`/`ctrl-u`, `home`/`end` | move                                                     | move                                   |
| `u`                                                     | update the selected addon, or take over an unmanaged one |                                        |
| `U`                                                     | update everything                                        |                                        |
| `a`                                                     | add an addon: paste a ref or URL, `Enter` installs       |                                        |
| `x`                                                     | remove the selected addon (`y` to confirm)               |                                        |
| `/`                                                     |                                                          | search; `Enter` runs it, `Esc` cancels |
| `o`                                                     |                                                          | cycle the sort                         |
| `h`/`l`, `Enter` on a group                             |                                                          | fold and open a category group         |
| `Enter`                                                 |                                                          | load details and the latest changelog  |
| `i`                                                     |                                                          | install the selected addon             |
| `n`/`p`                                                 |                                                          | next and previous page of results      |
| `f`                                                     | cycle flavor (era / forever)                             | cycle flavor                           |
| `r`                                                     | refresh latest versions                                  | run the search again                   |
| `?`                                                     | help                                                     |                                        |
| `q`, `Ctrl+C`                                           | quit                                                     | quit                                   |

Browse opens on trending addons for the flavor, grouped by category with counts; a group of more
than 20 starts folded. Installed results carry a `✓`. Colours are the terminal's own palette
entries, so they follow its theme.

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

## Finding addons

`search` asks every source that can be searched without a paid key at once and merges the
results, filtered to addons that support the current flavor unless `--all-flavors`. `browse`
lists the most downloaded (`popular`), `trending`, recently `updated` or alphabetical addons,
optionally in one `--category`. Each result carries a `ref` that `add` and `info` take as is, so
`wowaddon search map` → `wowaddon info cf:1735937` → `wowaddon add cf:1735937` is the whole loop.
A source that cannot answer a query is skipped and named on stderr (and in `sources` with
`--json`); the rest still answer.

What each source can match of its website:

| Source       | Search and browse                                                                                                               | Cannot match                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| CurseForge   | search, every sort, categories, details and changelog, via its v1 API (`CF_API_KEY`, else the keyless `api.curse.tools` mirror) | screenshots and comments                                                                                           |
| GitHub       | WowUp Hub's index of GitHub addons with packaged releases; info from the GitHub API                                             | categories; trending is the Hub's featured list; a repo without packaged releases is not indexed, so add it by URL |
| WoWInterface | its full file list, cached six hours and searched locally; downloads, monthly trending, categories                              | no WoW: Forever compatibility tag, so Forever searches skip it unless `--all-flavors`; no summary in listings      |
| Tukui        | ElvUI and Tukui, the only two addons its API lists                                                                              | download counts and categories                                                                                     |
| Wago         | not searched                                                                                                                    | its API needs a paid Patreon key and has no public search; add by URL or `wago:<slug>`                             |

## Coming from WowUp

wowaddon does everything WowUp did, so WowUp can go. `wowaddon adopt` takes over the addons
already installed: every AddOns folder no manifest line owns is matched to a source by WowUp's own
record of it (read only, from `~/.config/WowUp`, `~/.config/WowUpCf`, or the `AppData/Roaming`
folder of a Wine prefix under `~/Games` or `~/.wine`; `--wowup PATH` names another), then the
project ID in its TOC (`X-Curse-Project-ID`, `X-WoWI-ID`, `X-Tukui-ProjectID`), then a search by
its TOC title that is kept only when that addon ships a folder of the same name. A manifest line
not yet installed that names the folder wins over a new one, so nothing is listed twice. The
matches are added and installed fresh behind one WTF backup; `--dry-run` shows the plan, and
anything it cannot match is listed so you can add it by URL. `check` lists the folders still
untracked. Dev links are never touched. WowUp's own files are only read, never changed.

## Manifest and config

State lives under `${XDG_CONFIG_HOME:-~/.config}/wowaddon/`:

- `config.json` (optional): `{ "defaultFlavor": "era", "addonsDir": { "era": "...", "forever": "..." }, "backupKeep": 5 }`
- `era.txt` / `forever.txt`: one `kind ref  # note` per line (see `addons.example.txt`)
- `state/<flavor>.json`: installed versions and owned folders, written atomically
- `cache/cf-slugs.json`: CurseForge slug-to-id cache
- `cache/wowi-filelist.json`: WoWInterface file list for search, refreshed after six hours

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
{ "schemaVersion": 1, "command": "check", "flavor": "forever", "addonsDir": "...", "updates": 1, "addons": [Row], "untracked": [{ "folder": "Atlas" }] }
```

`search` and `browse` print `{ results: Listing[], sources: SourceReport[] }`, where a listing is
`{ ref, kind, name, summary, authors, downloads, updated, categories, gameVersions, flavors, url }`;
`info` prints `{ addon }` with that plus `version`, `links`, `folders`, `description` and
`changelog`; `adopt` prints `{ matches, addons, unmatched, skipped, backup }`.

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
