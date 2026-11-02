# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
