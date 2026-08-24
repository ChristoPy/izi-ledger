# Contributing

Thanks for looking. This is a library that moves money around, so the bar for
changes is a little higher than usual — mostly in the form of tests.

## Getting set up

```sh
bun install
bun run check        # lint + typecheck + the full suite
```

Other useful scripts:

| Script | |
| --- | --- |
| `bun test` | the suite on `bun:sqlite` |
| `bun run test:drivers` | the suite, then the built package on Node's two drivers |
| `bun run lint:fix` | format and autofix with Biome |
| `bun run example` | the runnable payments example |
| `bun run build` | dual ESM + CJS output with declarations |

`better-sqlite3` is a dev dependency so the Node driver path can be exercised
locally; it is an *optional peer* for consumers, never a hard requirement.

## Invariants that must keep holding

A change that breaks any of these needs a very good reason, and a test that
proves the new behaviour is what you meant:

1. **Every transaction nets to zero per currency.** No path writes an entry
   without the rest of its transaction.
2. **Movements are append-only.** Nothing issues an `UPDATE` against a movement
   row or a `DELETE` against anything.
3. **Both hash chains stay unbroken and gap-free**, and `verify()` catches any
   edit made directly to the file.
4. **Balances are exact integers.** Every addition is guarded against the safe
   integer boundary.
5. **One writer at a time.** Every operation goes through the mutex and every
   write through a single `BEGIN IMMEDIATE`.
6. **The cache can never answer with a balance the database disagrees with.**

## Changing the hash format or the schema

Both are versioned, and both make existing `.db` files unreadable when they
change. If you touch `movementHash`, `HASH_VERSION`, or the DDL, bump
`SCHEMA_VERSION` and say so in `CHANGELOG.md`.

## Tests

Put the test next to its peers — `movements`, `idempotency`, `integrity`,
`concurrency`, `cache`, `persistence`, `scenarios`, `api`, `units`. Prefer a
test that demonstrates the failure over one that asserts the implementation:
the integrity suite works by corrupting the database file directly and checking
that `verify()` notices, which is the shape to aim for.

If the change touches the driver adapter, add it to
`scripts/test-node-drivers.mjs` too, so it runs on `node:sqlite` and
`better-sqlite3` as well as `bun:sqlite`.

## Dependabot and the lockfile

Dependabot has no Bun lockfile support, so its npm PRs update `package.json`
and leave `bun.lock` behind — which `bun install --frozen-lockfile` refuses.
`.github/workflows/dependabot-lockfile.yml` regenerates the lockfile and commits
it back to the PR branch.

For the fix to also re-run CI, add a fine-grained personal access token with
`contents: write` on this repository as a repository secret named
`LOCKFILE_TOKEN`. Without it the lockfile is still committed, but pushes made
with `GITHUB_TOKEN` never start a workflow run, so the checks have to be
re-run by hand.

## Pull requests

CI runs lint, typecheck, the Bun suite on Linux and macOS, the Node suite on
20/22/24, and packaging checks. Green CI plus a note on what you changed and why
is all that is needed.
