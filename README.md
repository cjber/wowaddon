# wowaddon

Minimal CLI WoW addon installer/updater. Unifies multiple sources behind one
manifest — no GUI, no interactive TUI to fight, just `wowaddon` to sync.

Built because CurseBreaker's interactive TUI is hard to script and CurseForge
dropped its open API; this pulls release zips directly instead.

## Sources

| kind   | ref          | from                                            |
|--------|--------------|-------------------------------------------------|
| `gh`   | `OWNER/REPO` | latest GitHub release zip (falls back to source archive) |
| `wowi` | `FILE_ID`    | WoWInterface file id                            |

CurseForge is **not** supported — it has no open API and most authors block
third-party downloads. Use the GitHub or WoWInterface mirror instead.

## Usage

```sh
wowaddon                 # sync everything in the manifest
wowaddon add gh A/B      # append to manifest, then sync
```

- Manifest: `~/.config/wowaddon/addons.txt` (see `addons.example.txt`)
- Install target defaults to the Classic Era AddOns folder in the Steam/Proton
  prefix; override with `WOW_ADDONS=/path/to/Interface/AddOns`.

## Manifest format

```
# kind ref   # comment
gh   Questie/Questie
wowi 4459    # Bagnon
```

## Install

```sh
ln -s "$PWD/wowaddon" ~/.local/bin/wowaddon
```
