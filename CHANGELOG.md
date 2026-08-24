# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0.0, minor versions may contain breaking changes. Any change to the
movement hash format or to the SQLite schema will be called out here explicitly,
because it makes existing database files unreadable.

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/OWNER/izi-ledger/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/izi-ledger/releases/tag/v0.1.0
