# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.3.1] - 2026-11-12

### Fixed

- A folder bundled in several addons, such as `ForeverCore`, `LibStub` or Ace3, no longer makes
  every addon after the first fail with `OWNED_BY_OTHER`. Each owner installs and updates, the copy
  with the newest TOC `## Version` stays on disk, and the folder is removed only with its last
  owner. `check` and `list` rows name the other owners as `sharedFolders`.
- A CurseForge addon that bundles a folder kept as another CurseForge addon's development link now installs.
  A protected folder whose TOC names a different `## X-Curse-Project-ID` is left exactly as it is:
  an incoming newer copy does not replace it and removing the addon does not take it, while the
  addon's own protected folders are still never touched. Before, the whole addon was reported as
  `dev` and skipped.

## [2.3.0] - 2026-11-10

### Added

- `add` and `sync` install a CurseForge addon's required dependencies (the website's
  `RequiredDependency` type, `relationType` 3 in the official API) as normal manifest entries,
  recursing through their own requirements and stopping at a cycle.
  A dependency already tracked by `cf:<modId>` or contained in another tracked addon's installed
  folders is not added again; optional and other relations are ignored. `--dry-run` reports the
  dependencies and writes nothing. `add` and `sync` JSON gains `dependencies`, and `check` reports
  a tracked addon's required dependency that is neither tracked nor installed as
  `missingDependencies`.
- `add` takes several references, installing each in turn as `sync` does; a first argument that
  is itself a complete reference (`cf:`, `gh:`, `wowi:`, `tukui:`, `wago:`, `OWNER/REPO` or a URL)
  starts a list, while `add cf 327139` keeps the `<kind> <ref>` form. `add` JSON gains `addons`.

### Fixed

- A configured CurseForge key that `api.curseforge.com` rejects with HTTP 401 or 403 is reported
  instead of being hidden by the keyless fallback. `check` lists it as `keyProblems`, naming the
  `cf_token` file to replace, and every command prints the same warning once on stderr.

## [2.2.0] - 2026-11-10

### Added

- An expiring dev build: a symlinked AddOns folder whose TOC says
  `## Version: <tag>-dev+<sha>` is replaced by the release once the manifest source has a newer
  release than `<tag>`. `sync` removes only the symlink and installs the release, reporting the row
  as `updated` with the dev tag; until then it stays `dev` and `list` says which release it waits
  for. A symlink or checkout without that version form is untouched as before. Rows carry
  `devTag` in JSON.

### Fixed

- Adding a CurseForge project that has no public files yet says there is no build, instead of
  claiming CurseForge could not be reached.

## [2.1.7] - 2026-11-05

### Fixed

- `info` names the same CurseForge file as `check` and `sync` straight after an upload, instead
  of the previous file until CurseForge refreshes the project's latest files.
- `adopt` and installs ignore a zero `X-Curse-Project-ID` or `X-WoWI-ID` in a TOC instead of
  treating it as a project to look up.

## [2.1.6] - 2026-11-05

### Changed

- The terminal UI library moves to 0.8.2, which keeps raw mode on until a suspend settles, so
  the mouse reports and keys typed while the TUI hands the terminal to `$EDITOR` or suspends
  with Ctrl+Z are discarded instead of being echoed at the prompt or read by the next program.
  Wrapped text also keeps its full height in centred and flex-start layouts, so a long body no
  longer loses rows in a short dialog.

## [2.1.5] - 2026-11-04

### Fixed

- The TUI exits when its terminal closes (SIGHUP, stdin ending, or an EIO or EPIPE error on the
  terminal) instead of running on in the background with no terminal. SIGQUIT and SIGPIPE exit it too.

## [2.1.4] - 2026-11-04

### Added

- Interactive runs check for updates in the background after their command, never waiting on the
  network: a detached process resolves each addon's latest release (at most hourly) and the latest
  wowaddon release (every six hours), backing off from 15 minutes to a day after a failure.
  `list` now shows `update` and `current` from those cached releases without `--refresh`, and a
  run ends with a one-line stderr notice when a newer wowaddon exists. `sync`, `add`, `check` and
  `list --refresh` cache what they resolve too. `WOWADDON_NO_UPDATE_CHECK=1` turns it off.

### Fixed

- `add` names a CurseForge addon given by its numeric ID or a cached slug in the manifest
  (`cf 298842  # Leatrix Maps`), so `list` shows its name rather than the bare ID. A failed title
  lookup still adds the addon, unnamed.

## [2.1.3] - 2026-11-02

### Fixed

- `check` reports a missing addon as `unmanaged`, or `dev` for a symlink or checkout, whenever
  `sync` would, instead of `missing`. It matches untracked folders by the project ID in their TOC
  (`X-Curse-Project-ID`, `X-WoWI-ID`, `X-Wago-ID`) and by the folder list the source publishes, and
  downloads a release only for a same-named folder neither settles. The schema and README say what
  `check` can and cannot see.
- `add` is all or nothing: the manifest gains the addon only when it installs (or with
  `--no-install`), so an add that fails on a network error, a missing build, a bad ref or a broken
  archive can be rerun instead of failing with `DUPLICATE`.
- `bun run build` builds the binary for this machine instead of failing on the other
  architecture's missing native package; `bun run build all` builds both after
  `bun install --os linux --cpu "*"`. The gate now runs the host build.

## [2.1.2] - 2026-11-02

### Fixed

- `add` stopped by a folder installed outside wowaddon (`unmanaged`) no longer writes the addon to
  the manifest, so rerunning it with `--adopt` takes the folder over instead of failing with
  `DUPLICATE`.
- `add --dry-run` and `sync --dry-run` follow the real run's path: they download each release they
  would install and check its folders, so they report `unmanaged` or `dev` exactly when the real
  run would. `sync --dry-run` also honours `--adopt`.
- A skipped dev link says how to replace it: remove the symlink or checkout, then run sync.
- The TUI's install key reports what an install did instead of always saying "installed", and
  taking over an install stopped by an unmanaged folder reruns it with adopt.

## [2.1.1] - 2026-11-02

### Changed

- The TUI uses the terminal's palette throughout: each source tag has its own colour, statuses are
  coloured by meaning, versions and dates are dimmed, and the keys line shows each key in the accent
  colour.
- The keys line fits on one line from about 100 columns; paging and other less used keys are in `?`
  help, which now also works in the browse view. On a narrow terminal `q quit` wraps together with
  `? help`, never alone.
- The installed view's pane under the list shows the selected addon's status, version, latest
  version, install date and folders, instead of one line followed by empty rows.

### Fixed

- `info` and search results list game versions in numeric order, so 2.5.5 comes before 10.0.0.

## [2.1.0] - 2026-11-02

### Added

- `wowaddon search`, `browse`, `info` and `categories`: find addons across CurseForge, GitHub (via
  the WowUp Hub index), WoWInterface and Tukui, filtered to the flavor, sorted by relevance,
  downloads, update date or name, by category, with details, links and the latest changelog. Each
  result's `ref` goes straight to `add`. Where a source cannot match its website is stated in the
  help, schema and README.
- `wowaddon adopt`: takes over installed addons wowaddon does not manage, matched by WowUp's own
  records (read only), the TOC's project IDs or the TOC title, behind one WTF backup. wowaddon now
  fully replaces WowUp.
- `check` lists untracked AddOns folders in `untracked`.
- A browse view in the TUI (`tab`): trending on open, `/` search, `o` sort, category groups that
  fold, details on `Enter` and one-key install with `i`. Both views share one frame, so switching
  keeps the page height and each view's place, and colours come from the terminal's palette.

## [2.0.2] - 2026-11-02

### Fixed

- Windows-made packages whose folder entries end in a backslash, such as AtlasLoot Classic Forever
  1.2.7, install instead of failing with "ZIP has a case collision or duplicate path".

## [2.0.1] - 2026-11-02

### Fixed

- Packages zipped on Windows with backslash paths, such as AtlasLoot Classic Forever 1.2.7, install
  instead of failing with "Unsafe ZIP path". Paths that climb out of the AddOns folder still fail.

## [2.0.0] - 2026-11-02

### Added

- `--json` on every command: one JSON document on stdout with a `schemaVersion`, the flavor and
  AddOns folder, and typed error codes on failed rows and failed commands.
- `wowaddon schema`, describing commands, flags, JSON output, statuses, error codes and exit codes.
- `wowaddon check`, reporting which addons `sync` would install or update without installing.
- `--dry-run` on `sync`, `add` and `remove`.
- Exit code `3` when another wowaddon run holds the lock.
- A WTF snapshot before `sync` changes anything, under `~/.local/state/wowaddon/backups/<flavor>/`,
  keeping the newest `backupKeep` (default 5), with `--no-backup` to skip it.
- Tukui (`tukui:elvui`, `tukui:tukui`) and Wago Addons (`wago:<slug>`, with `WAGO_ADDONS_API_KEY`)
  as sources.
- An agent skill at `skills/wowaddon/SKILL.md`.
- `remove` and `sync` find a manifest entry by its bare ref, such as `elvui`.

### Changed

- `list --json` prints the JSON envelope with the rows under `addons`, not a bare array.

### Fixed

- A dev-linked folder named after a GitHub, Tukui or Wago addon that has no state record shows as
  `dev`, not `missing`, and sync skips it.

## [1.0.0] - 2026-11-02

### Added

- Bun + TypeScript rewrite of the Python `wowaddon` script.
- CurseForge support without an API key, and WoW: Forever (`_forever_`) as a second flavor alongside
  Classic Era.
- A terminal UI (`@opentui/react`) alongside the existing CLI: `sync`, `add`, `remove`,
  `list`.
- Per-flavor manifests and installed-state tracking, with automatic migration of a legacy
  `addons.txt` to `era.txt`.
- Dev-link protection: symlinked, git-tracked or in-worktree addon folders are skipped
  rather than overwritten, and removing one stops tracking it while its folder stays as it is.
- Standalone Linux binaries (x64 and arm64) attached to each GitHub release.
