# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, minor versions may contain breaking changes. Any change to the
movement hash format or to the SQLite schema will be called out here explicitly,
because it makes existing database files unreadable.

## [Unreleased]

Nothing yet.

## [0.3.0] — 2026-08-25

### Changed

- **Breaking: there is no built-in default currency.** `defaultCurrency` used
  to fall back to `'BRL'`, an arbitrary choice baked into the library. A wallet
  created with neither its own `currency` nor a ledger `defaultCurrency` now
  throws `InvalidArgumentError` naming both ways to fix it.

  Single-currency books set `defaultCurrency` once on the ledger and are
  otherwise unchanged. Multi-currency books leave it unset and name the
  currency on each wallet, which is where it belongs — they no longer have to
  elect an arbitrary default that means nothing.

  Existing databases are unaffected: every wallet already stores its own
  currency, so only `createWallet` behaves differently. No schema change.

## [0.2.1] — 2026-08-24

### Fixed

- Documentation only; no code changes. The README had drifted from the API
  after checkpoints landed: `verify()` was still documented as taking only a
  wallet id, `checkpoint()` and `listCheckpoints()` were missing from the
  method table, `signer` was missing from the options, and the `verify()`
  example showed an issue without its `category`. The paragraph on what
  verification detects now points at the checkpoint section rather than ending
  on the list of things it catches, since a full rewrite is not one of them.

## [0.2.0] — 2026-08-24

### Added

- `checkpoint()` produces a signed, compact commitment to the ledger at a point
  in time. Published somewhere the ledger's operators do not control, it closes
  the one gap the hash chain cannot: someone with the file and this library can
  rewrite every movement consistently and pass `verify()`, but cannot reproduce
  a commitment made before the rewrite.
- `verify({ anchors, publicKeys })` checks the ledger against those published
  checkpoints, and `listCheckpoints()` returns the local record of them.
- A `Signer` interface plus `ed25519Signer` and `generateSigningKeyPair`.
  Signing is an interface rather than a key so the secret can live in a KMS
  or HSM.
- `audit()` and an `izi-ledger audit` command that verify a ledger file from
  outside, needing only the file, the anchors and a public key.
- Everything is exported from the package root. There are no subpath entries,
  so consumers on the older `moduleResolution: node` resolve it all too.
- `IntegrityIssue` now carries a `category` of `'chain' | 'anchor' |
  'signature'`, so a report can say which part of the proof failed.

### Changed

- **Schema v3.** Adds a `checkpoints` table and a `ledger_id` in `meta`. Files
  written by v2 are not readable; this is pre-1.0 and there is no migration.

## [0.1.0] — 2026-08-24

First release.

### Added

- `ledger()` opens a ledger; the returned object exposes `createWallet`,
  `getBalance`, `getBalances`, `addMovement`, `getWallet`, `listWallets`,
  `getTransaction`, `listMovements`, `verify`, `stats` and `close`.
- Double-entry transactions that must net to zero per currency, with wallets
  carrying their own currency and an opt-in `allowNegative`.
- Two hash chains per movement: `prevHash` over the ledger's global order and
  `prevWalletHash` over each wallet's own history, so one account can be
  audited without walking everything else.
- Required idempotency keys, checked against a fingerprint of the whole request
  both before and inside the write lock.
- A balance cache written through after commit, invalidated across processes by
  watching SQLite's `data_version`.
- Runtime driver resolution across `bun:sqlite`, `node:sqlite` and
  `better-sqlite3`, with no mandatory runtime dependency.
- `verify()` re-hashes and re-links the chain, whole ledger or one wallet.
- Dual ESM and CommonJS builds with separate type declarations for each.

[Unreleased]: https://github.com/ChristoPy/izi-ledger/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ChristoPy/izi-ledger/releases/tag/v0.3.0
[0.2.1]: https://github.com/ChristoPy/izi-ledger/releases/tag/v0.2.1
[0.2.0]: https://github.com/ChristoPy/izi-ledger/releases/tag/v0.2.0
[0.1.0]: https://github.com/ChristoPy/izi-ledger/releases/tag/v0.1.0
