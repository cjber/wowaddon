---

name: wowaddon
description: Install, update, check or remove World of Warcraft addons for Classic Era or WoW: Forever with the wowaddon CLI, from GitHub, CurseForge, WoWInterface, Tukui (ElvUI) or Wago Addons. Use for 'update my addons', 'install <addon>', 'which addons are outdated' or removing an addon.
---

# wowaddon

Pass `--json` to every command: each run prints one JSON document on stdout, progress goes to
stderr. `wowaddon schema` describes every command, flag, output shape, status, error code and exit
code; read it once instead of parsing `--help`. Add `--flavor era|forever` whenever the user names a
client.

1. Run `wowaddon check --json`. `updates` counts addons sync would install or update; rows with
   status `error` carry a `code` and `message`.
2. Before any change the user did not spell out, preview it with `--dry-run` on `sync`, `add` or
   `remove` and show the user what would change.
3. Run the change: `wowaddon sync --json` (optionally with ids), `wowaddon add <ref|url> --json`
   or `wowaddon remove <id|ref> --json`. Done when the exit code is 0 and no row has status
   `error`.
4. Report `backup` from the sync output: the WTF snapshot taken before the first change.

On exit code 1, report each failed row's `code` and `message`. On 2, fix the command or ask for
the AddOns folder (`CONFIG_MISSING`, `CONFIG_AMBIGUOUS`: pass `--addons-dir`). On 3, another run
holds the lock, so wait and retry. 130 means the user cancelled.

Safety rules:

- A `dev` row is a symlink, git checkout or worktree under development. wowaddon never touches
  it, and neither do you: no deleting, replacing or editing those folders by hand.
- `unmanaged` means a folder installed outside wowaddon. Pass `--adopt` only after the user
  agrees it may be replaced.
- Keep `--no-backup` for when the user asks for it; the snapshot protects their SavedVariables.
- `WAGO_KEY_MISSING`: Wago Addons needs the user's own API key (a paid Wago Patreon feature).
  Tell them to set `WAGO_ADDONS_API_KEY` or write `~/.config/wowaddon/wago_token`; never ask
  them to paste the key into the chat or a tracked file.
