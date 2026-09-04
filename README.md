# CommonCrane

The room: matchmaking, presence, rollback and the relay half of it, shared by
the games beside this repo.

## Versions

The library used to be a symlink into every game at once. It is now released,
so a game holds still at the version it names until it asks for another.

```
packages/room/src/      the working copy — always whatever comes next
packages/room/dist/     built output, not committed
releases/               the released versions, committed
  johnnypickles-room-2.0.0.tgz
```

A game names one:

```json
"@johnnypickles/room": "file:../../../CommonCrane/releases/johnnypickles-room-2.0.0.tgz"
```

npm unpacks a tarball rather than linking it, so that game has its own copy and
an edit here cannot reach it. It still assumes CommonCrane sits beside the game
repo, as the symlink did.

### Cutting one

```
npm run release -- minor          # or major, patch, or an exact 1.2.3
```

Refuses a dirty tree, runs every game's suite against this working copy first,
then writes the tarball, commits and tags. `--skip-checks` if the release is
meant to break somebody.

A game's suite is red for its own reasons, so the gate does not stop for a red
check. Each release records how the games stood when it was cut, beside its
tarball:

```
releases/johnnypickles-room-2.0.0.tgz
releases/johnnypickles-room-2.0.0.tgz.checks.json
```

The next release compares against that and stops only for a check that was
passing then and fails now. Everything else is reported and let through.

### Moving a game onto one

```
npm run pin -- 2.1.0              # every game
npm run pin -- 2.1.0 PuckPenguin  # only that one
npm run pin -- 2.1.0 --dry-run    # say what would change
```

Rewrites the manifests and installs. Games can sit on different versions; that
is the point. It also moves a manifest off an older name, which is how the five
games came across from `@cc/room`.

### Before you release

```
npm run test:consumers
```

Runs each game's `typecheck` and `test` against **this working copy**, standing
it in for the version that game has pinned and putting the pinned one back
afterwards. It answers "would releasing this break anybody", which their own
suites can no longer answer for themselves now that they are pinned.

## Publishing

The games install from `releases/`, which needs no registry and works offline.
npm is for everybody else.

```
npm run build                 # dist/, JS + .d.ts
npm publish --workspace=@johnnypickles/room --access public
```

The package ships `dist/` only — compiled JS with declarations, so it works
under plain node and tsc rather than only inside a bundler. The sources import
each other with `.ts` extensions and TypeScript rewrites those on the way out,
so nothing in `src/` needs to know it is being published.

## License

MIT — see [LICENSE](LICENSE).
