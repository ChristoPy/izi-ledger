# izi-ledger

[![CI](https://github.com/ChristoPy/izi-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristoPy/izi-ledger/actions/workflows/ci.yml)

Double-entry, zero-sum, hash-chained ledgers on SQLite — with strong consistency,
idempotency and crash safety built in. Works on **Node** and **Bun**, no native
build step required.

```ts
import { ledger } from 'izi-ledger'

const book = await ledger('./ledger.db')

await book.createWallet({ id: 'gateway', allowNegative: true })
await book.createWallet({ id: 'user:1' })
await book.createWallet({ id: 'fees' })

await book.addMovement(
  [
    { walletId: 'gateway', amount: -10_000 }, // R$ 100,00 leaving the gateway
    { walletId: 'user:1',  amount:   9_750 }, // credited to the user
    { walletId: 'fees',    amount:     250 }, // our fee
  ],
  { idempotencyKey: 'payment:abc-123' },
)

await book.getBalance('user:1') // 9750
```

## Install

```sh
npm install izi-ledger      # bun add izi-ledger / pnpm add izi-ledger
```

Zero runtime dependencies, and one entry point: everything is exported from
`izi-ledger` itself, with no subpaths, so an older `moduleResolution: node`
consumer resolves all of it.

The SQLite driver is picked at runtime:

| Runtime | Driver used | Needs an install? |
| --- | --- | --- |
| Bun | `bun:sqlite` | no |
| Node ≥ 22.5 | `node:sqlite` (built-in) | no |
| Node 20 / 22.0–22.4 | `better-sqlite3` | `npm i better-sqlite3` (optional peer) |

Force one with `ledger({ driver: 'node:sqlite' })` or `IZI_LEDGER_DRIVER=node:sqlite`.
`availableDrivers()` reports what the current runtime can load.

Two things worth knowing: Node still prints an `ExperimentalWarning` for its
built-in `node:sqlite`, and `better-sqlite3` is a native addon that Bun cannot
load today — which is exactly why the driver is chosen at runtime instead of
being a hard dependency.

One sharp edge if you *force* `better-sqlite3` on Node 24 or newer: v11 aborts
there, inside its own destructor, once the Node environment has been torn down.
v12 fixes that but ships no Node 20 prebuild, so Node 20 installs get v11. In
normal use this never comes up — from Node 22.5 the built-in `node:sqlite` wins
driver resolution and the addon is never loaded. If you do force it on Node 24+,
require `better-sqlite3@>=12`.

## Model

- **Amounts are integers in the currency's minor unit** (cents). `10.5` is
  rejected; pass `1050`. Anything outside `Number.MAX_SAFE_INTEGER` is rejected
  too, so arithmetic is always exact.
- **Every transaction is zero-sum.** `addMovement` takes an array of entries and
  the amounts must add up to `0` *per currency*. That is what makes "the amount
  received goes in index 0, the fee in index 1" a single atomic fact rather than
  two writes that can drift apart.
- **Wallets are explicit.** `createWallet` is the only way to make one, so a
  typo in a wallet id is an error, not a new account — and its currency is
  never guessed.
- **Nothing is ever updated or deleted.** A refund is a new, opposite movement.
- **Every transaction carries an idempotency key.** It is a required argument,
  not an opt-in.

## Every movement records

| Field | |
| --- | --- |
| `walletId` | which wallet moved |
| `amount` | signed integer, minor units |
| `balance` | the wallet's balance **immediately after** this movement |
| `txId` | groups the entries of one `addMovement` call |
| `idempotencyKey` | the key of that transaction — stored once, on the transaction, and rejoined on read |
| `timestamp` | epoch ms, guaranteed non-decreasing across the ledger |
| `seq` / `walletSeq` | gap-free position, globally and within the wallet |
| `hash` | SHA-256 over every field above, plus both previous hashes |
| `prevHash` | hash of the previous movement in the whole ledger |
| `prevWalletHash` | hash of the previous movement in *this wallet* |
| `currency`, `metadata` | |

Two chains, one write. `prevHash` makes the ledger's global ordering
tamper-evident; `prevWalletHash` lets you audit a single wallet without walking
everything else.

```ts
const result = await book.verify()          // whole ledger
const forUser = await book.verify('user:1') // just this wallet's chain
// { ok: false, checked: 12, anchorsChecked: 0, issues: [
//   { seq: 7, walletId: 'user:1', category: 'chain', reason: 'Hash mismatch at seq 7: …' },
// ] }
```

`verify()` re-hashes every movement, re-links both chains, recomputes every
running balance, re-derives each transaction's request fingerprint, and checks
that the ledger still nets to zero per currency. Editing a single amount with a
`sqlite3` shell is detected — as is deleting a row, re-pointing a hash,
doctoring a wallet's stored balance, or rewriting an idempotency key. Pass
`verifyOnOpen: true` to run it at startup.

What it cannot detect on its own is a rewrite that recomputes *everything* —
see [Checkpoints](#checkpoints-and-proving-it-to-someone-else) below, which is
the part that makes the result mean something to somebody else.

## Checkpoints, and proving it to someone else

The hash chain is tamper-**evident**, not tamper-proof. Anyone who can write to
the file and run this library can rewrite every movement, recompute every hash
and fingerprint, and `verify()` will pass — the chain proves internal
consistency, not authenticity.

A checkpoint is a compact commitment to the ledger at a point in time. Publish
it somewhere the ledger's operators do not control, and a later rewrite becomes
impossible to hide: it cannot reproduce a commitment that left the building
before it happened.

```ts
import { ledger, ed25519Signer, generateSigningKeyPair } from 'izi-ledger'

// Once, at setup. Keep the private half somewhere the app cannot read, and
// hand the public half to whoever will be checking your work.
const { privateKey, publicKey } = generateSigningKeyPair()

const book = await ledger({
  path: './ledger.db',
  signer: ed25519Signer({ keyId: 'ledger-2026-01', privateKey }),
})

const anchor = await book.checkpoint()
// { seq, headHash, movementCount, totals: { BRL: 0 }, timestamp,
//   previousCheckpoint, hash, signature: { algorithm, keyId, value } }

await publishSomewhereYouDoNotControl(anchor)   // TSA, S3 Object Lock, the auditor
```

Feed them back to catch a rewrite:

```ts
await book.verify({ anchors: [anchor], publicKeys: { 'ledger-2026-01': publicKey } })
```

`checkpoint()` is manual on purpose — how often to commit, and where to put the
result, are policy decisions the library should not make for you. Each
checkpoint links to the previous one, so a missing one is visible too.

### Signing

`Signer` is an interface, not a private key, because the point of signing is
that an auditor verifies with the **public** half and gains no power to forge.
That only pays off if the secret can live somewhere the application cannot read:

```ts
signer: { keyId: 'ledger-2026-01', sign: (bytes) => kms.sign(bytes) }
```

`ed25519Signer` is the batteries-included version for a local key.

### The audit command

An auditor is not going to write TypeScript. The package ships a command that
needs the file, the published checkpoints, and a public key — no application
code, no secrets:

```sh
npx izi-ledger audit ./ledger.db \
  --anchors anchors.json \
  --public-key ledger-2026-01.pem
```

```
ledger.db  ·  node:sqlite

  ledger      ok      24 movements re-hashed
  anchors     ok      3 checked
  signatures  ok      3 verified
  zero-sum    ok      BRL: 0
  ledger id           a4c35862-5900-4373-9f1e-8741e9041f77

VERIFIED
```

Exits 0 when it verifies, 1 when it does not, 2 on a usage error. `--json` for
machines. Each row reports its own check, so a broken chain does not make the
signatures look forged.

Where to publish anchors, roughly in order of what they buy you:

| destination | insider can rewrite? | auditor verifies alone? |
| --- | --- | --- |
| plain S3 bucket | yes | no |
| S3 + Object Lock (compliance) | no | needs read access |
| RFC 3161 timestamp authority | no | **yes, with the TSA cert alone** |
| a public transparency log | no | yes, publicly |
| sent straight to the auditor | no | yes |

## Idempotency

`addMovement` **requires** an `idempotencyKey`, which makes every call safe to
retry — from a queue consumer, a webhook, a client that timed out, or another
process on the same file. There is no unguarded variant on purpose: a write
without a key is a double credit waiting for the first retry.

```ts
const a = await book.addMovement(entries, 'payment:abc')
const b = await book.addMovement(entries, 'payment:abc')
b.replayed // true
b.id === a.id // true — nothing was written the second time
```

Reusing a key with *different* entries throws `IdempotencyConflictError` rather
than silently doing the wrong thing. The check compares a fingerprint of the
whole request (entries, order, amounts and metadata), and it happens both before
and inside the write lock, so a concurrent duplicate cannot slip through.

The key is stored in exactly one place — on the transaction — and every movement
hash covers it, so rewriting it directly in SQLite invalidates that
transaction's whole chain rather than quietly disabling replay protection.

## Concurrency and consistency

Every operation goes through one FIFO queue and one `BEGIN IMMEDIATE`
transaction, so:

- `await Promise.all([...200 writes])` all land, in call order, with a gap-free
  sequence — no lost updates, no interleaving.
- A read never observes a half-applied transaction.
- A failed entry rolls the whole transaction back: no partial rows, and the
  idempotency key stays free for a corrected request.

The database is opened in WAL mode with `synchronous = FULL`, so a committed
transaction survives a crash. Use `durability: 'normal'` to trade the per-commit
fsync for speed.

## Balance cache

Balances are cached in memory (bounded LRU, 10 000 wallets by default) and
written through on commit, so the usual "move money, then read the balance"
sequence never touches SQLite:

```ts
await book.addMovement(entries, 'k')
await book.getBalance('fees') // served from cache
```

It stays correct when another process writes to the same file: the ledger
watches SQLite's `data_version` and drops the cache the moment a foreign commit
appears. `cacheSize: 0` turns it off; `stats()` exposes hits, misses and
invalidations.

## API

```ts
const book = await ledger(options?: string | LedgerOptions)
```

| Option | Default | |
| --- | --- | --- |
| `path` | `':memory:'` | database file |
| `driver` | auto | `'bun:sqlite' \| 'node:sqlite' \| 'better-sqlite3'` |
| `durability` | `'full'` | `'normal'` skips the per-commit fsync |
| `defaultCurrency` | none | currency wallets inherit; without it every wallet must name its own |
| `cacheSize` | `10_000` | wallets kept in the balance cache; `0` disables |
| `busyTimeoutMs` | `5_000` | wait on a locked database before failing |
| `verifyOnOpen` | `false` | verify the whole chain at startup |
| `now` | `Date.now` | clock injection for deterministic tests |
| `signer` | none | signs checkpoints as they are produced; see [Signing](#signing) |

| Method | |
| --- | --- |
| `createWallet(id \| options)` | the only way to create a wallet |
| `getBalance(walletId)` | current balance, minor units |
| `getBalances(walletIds)` | several at once |
| `addMovement(entries, key \| options)` | one zero-sum transaction; the key is required |
| `getWallet(id)` / `listWallets()` | |
| `getTransaction(keyOrTxId)` | |
| `listMovements({ walletId, txId, idempotencyKey, afterSeq, limit, order })` | statements, cursor-paginated |
| `verify(walletId \| options)` | re-hash and re-link the chain; pass `{ anchors, publicKeys }` to check it against published checkpoints |
| `checkpoint()` | a signed commitment to the ledger right now, to publish elsewhere |
| `listCheckpoints()` | the local record of checkpoints, oldest first |
| `stats()` | counts, head hash, cache metrics |
| `close()` | drains in-flight work, then closes |

### Wallets

```ts
await book.createWallet({
  id: 'revenue:fees',
  currency: 'BRL',        // movements only net to zero within one currency
  allowNegative: true,    // system/revenue/clearing accounts need this
  metadata: { team: 'finance' },
})
```

`allowNegative` is off by default, so a user wallet cannot be overdrawn by
accident — the transaction fails with `InsufficientFundsError` and rolls back.

**A currency is never invented for you.** Every wallet gets one from its own
`currency` or from the ledger's `defaultCurrency`, and a wallet with neither is
an error rather than a guess — putting a label on somebody's money that nobody
chose is the kind of quiet mistake the rest of this library exists to prevent.

```ts
// single-currency book: say it once
const book = await ledger({ path: './ledger.db', defaultCurrency: 'BRL' })
await book.createWallet('user:1')                            // inherits BRL

// multi-currency book: no default to invent, so name it every time
const book = await ledger({ path: './ledger.db' })
await book.createWallet({ id: 'brl:user', currency: 'BRL' })
await book.createWallet('user:1')                            // throws
```

### Multiple currencies

A transaction may touch several currencies as long as **each one balances on its
own**. An FX move therefore goes through an explicit clearing wallet, which is
the point — the exchange becomes a fact on the ledger instead of an implicit
conversion:

```ts
await book.addMovement([
  { walletId: 'brl:user', amount: -5_000 },
  { walletId: 'brl:fx',   amount:  5_000 },
  { walletId: 'usd:fx',   amount: -1_000 },
  { walletId: 'usd:user', amount:  1_000 },
], 'fx:1')
```

## Errors

Every error extends `LedgerError` and carries a stable `code`:

`WALLET_NOT_FOUND` · `WALLET_ALREADY_EXISTS` · `INVALID_AMOUNT` ·
`INVALID_ARGUMENT` · `UNBALANCED_MOVEMENT` · `CURRENCY_MISMATCH` ·
`INSUFFICIENT_FUNDS` · `IDEMPOTENCY_CONFLICT` · `INTEGRITY_ERROR` ·
`SCHEMA_VERSION_MISMATCH` · `LEDGER_CLOSED` · `DRIVER_UNAVAILABLE`

```ts
import { InsufficientFundsError } from 'izi-ledger'

try {
  await book.addMovement(entries)
} catch (error) {
  if (error instanceof InsufficientFundsError) {
    error.walletId; error.balance; error.attempted
  }
}
```

## Development

```sh
bun install
bun run check          # lint + typecheck + the full suite
bun run example        # the runnable payments example
bun run example:audit  # the checkpoint and audit loop, end to end
bun run test:drivers   # the suite, then the built package on Node's two drivers
bun run check:package  # publint + are-the-types-wrong against the built tarball
bun run build          # dual ESM + CJS output, with declarations for each
```

CI runs lint and typecheck, the Bun suite on Linux and macOS, the Node suite on
20/22/24, both examples, and `check:package` — the same script as above, so a
laptop and CI cannot drift apart on it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the invariants a change has to keep
holding, and [SECURITY.md](SECURITY.md) for what the hash chain does and does
not protect against.

## License

MIT
