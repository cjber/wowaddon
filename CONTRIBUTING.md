# Contributing

[AGENTS.md](AGENTS.md) has the layout and the rules a change must keep.

## Making a change

```sh
bun install --frozen-lockfile
bun run gate
```

A change needs:

- a passing gate
- offline tests, with `fetch` injected through `setFetch()`, including the case that must be skipped for any change
  to what gets installed or removed
- a line under Unreleased in `CHANGELOG.md` if a user would notice it
- matching updates to `README.md` and `--help` if a command or flag changed

## Releasing

Run `bun scripts/release.ts patch|minor|major` on a branch and merge it. Then run `bun scripts/release.ts tag` on the
merged `main` commit and push the tag. The tag builds the Linux binaries and publishes the GitHub release with the
version's `CHANGELOG.md` entry as its notes.
