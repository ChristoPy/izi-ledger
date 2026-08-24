# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, minor versions may contain breaking changes. Any change to the
movement hash format or to the SQLite schema will be called out here explicitly,
because it makes existing database files unreadable.

## [Unreleased]

### Added

- `checkpoint()` produces a signed, compact commitment to the ledger at a point
  in time. Published somewhere the ledger's operators do not control, it closes
  the one gap the hash chain cannot: someone with the file and this library can
  rewrite every movement consistently and pass `verify()`, but cannot reproduce
  a commitment made before the rewrite.
- `verify({ anchors, publicKeys })` checks the ledger against those published
  checkpoints, and `listCheckpoints()` returns the local record of them.
- A `Signer` interface plus `ed25519Signer` and `generateSigningKeyPair`,
  exported from `izi-ledger/signing`. Signing is an interface rather than a key
  so the secret can live in a KMS or HSM.
- `audit()` (`izi-ledger/audit`) and an `izi-ledger audit` command that verify a
  ledger file from outside, needing only the file, the anchors and a public key.
- `IntegrityIssue` now carries a `category` of `'chain' | 'anchor' |
  'signature'`, so a report can say which part of the proof failed.

### Changed

- **Schema v3.** Adds a `checkpoints` table and a `ledger_id` in `meta`. Files
  written by v2 are not readable; this is pre-1.0 and there is no migration.

## [0.1.0] — unreleased

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

[Unreleased]: https://github.com/ChristoPy/izi-ledger/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ChristoPy/izi-ledger/releases/tag/v0.1.0
