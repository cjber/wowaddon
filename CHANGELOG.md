# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
