# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
