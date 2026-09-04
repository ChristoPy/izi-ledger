import { randomUUID } from 'node:crypto'
import type { Driver, SqlRow } from './driver/index.js'
import { LedgerNotFoundError, SchemaVersionMismatchError } from './errors.js'

export const SCHEMA_VERSION = 3

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS wallets (
  id             TEXT PRIMARY KEY,
  currency       TEXT    NOT NULL,
  allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0, 1)),
  balance        INTEGER NOT NULL DEFAULT 0,
  movement_count INTEGER NOT NULL DEFAULT 0,
  head_hash      TEXT,
  metadata       TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT    NOT NULL UNIQUE,
  request_hash    TEXT    NOT NULL,
  timestamp       INTEGER NOT NULL,
  seq_start       INTEGER NOT NULL,
  entry_count     INTEGER NOT NULL,
  metadata        TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS movements (
  seq              INTEGER PRIMARY KEY,
  tx_id            TEXT    NOT NULL REFERENCES transactions(id),
  wallet_id        TEXT    NOT NULL REFERENCES wallets(id),
  currency         TEXT    NOT NULL,
  amount           INTEGER NOT NULL,
  balance          INTEGER NOT NULL,
  timestamp        INTEGER NOT NULL,
  hash             TEXT    NOT NULL UNIQUE,
  prev_hash        TEXT,
  prev_wallet_hash TEXT,
  wallet_seq       INTEGER NOT NULL,
  metadata         TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS checkpoints (
  seq                 INTEGER PRIMARY KEY,
  ledger_id           TEXT    NOT NULL,
  head_hash           TEXT,
  movement_count      INTEGER NOT NULL,
  totals              TEXT    NOT NULL,
  timestamp           INTEGER NOT NULL,
  previous_checkpoint TEXT,
  hash                TEXT    NOT NULL UNIQUE,
  signature           TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS movements_wallet_seq ON movements (wallet_id, seq);
CREATE INDEX IF NOT EXISTS movements_tx         ON movements (tx_id);
CREATE UNIQUE INDEX IF NOT EXISTS movements_wallet_pos ON movements (wallet_id, wallet_seq);
`

export interface PragmaOptions {
  durability: 'full' | 'normal'
  busyTimeoutMs: number
  readonly?: boolean
}

export function applyPragmas(driver: Driver, options: PragmaOptions): void {
  // Both of these describe how this connection *writes*, and setting them on a
  // read-only handle is at best a no-op — SQLite is free to reject it, and the
  // drivers do not agree on which. A reader has no use for either.
  if (!options.readonly) {
    // WAL lets readers work while a writer holds the write lock; it is a no-op
    // (silently "memory") for :memory: databases.
    driver.exec(`PRAGMA journal_mode = WAL;`)
    driver.exec(`PRAGMA synchronous = ${options.durability === 'full' ? 'FULL' : 'NORMAL'};`)
  }
  driver.exec(`PRAGMA foreign_keys = ON;`)
  driver.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))};`)
  // Every write is a single BEGIN IMMEDIATE transaction, so we want the write
  // lock taken up front rather than after a deferred read upgrade fails.
  driver.exec(`PRAGMA trusted_schema = OFF;`)
}

const SCHEMA_VERSION_QUERY = `SELECT value FROM meta WHERE key = 'schema_version'`

export function applySchema(driver: Driver): void {
  driver.exec('BEGIN IMMEDIATE;')
  try {
    driver.exec(DDL)
    const row = driver.prepare(SCHEMA_VERSION_QUERY).get()
    if (row === undefined) {
      const insert = driver.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
      insert.run('schema_version', String(SCHEMA_VERSION))
      insert.run('last_seq', '0')
      insert.run('head_hash', null)
      insert.run('last_timestamp', '0')
      // Stable identity for this book. A checkpoint carries it so an auditor
      // can tell that the file in front of them is the ledger the anchors
      // describe, rather than a different one that happens to verify.
      insert.run('ledger_id', randomUUID())
      insert.run('checkpoint_head', null)
    } else {
      const found = Number(row.value)
      if (found !== SCHEMA_VERSION) {
        throw new SchemaVersionMismatchError(found, SCHEMA_VERSION)
      }
    }
    driver.exec('COMMIT;')
  } catch (error) {
    try {
      driver.exec('ROLLBACK;')
    } catch {
      // The transaction was already rolled back by SQLite.
    }
    throw error
  }
}

/**
 * The read-only counterpart to `applySchema`: check what is in the file rather
 * than create what is missing.
 *
 * `applySchema` answers "make this a ledger", which on an empty file means
 * minting a fresh `ledger_id` and a book with nothing in it. That is the right
 * answer for an application opening its own database and the wrong one for a
 * verifier, which needs "there is no ledger here" to be an error it reports
 * rather than a clean bill of health for a book it just created.
 */
export function assertSchema(driver: Driver, path: string): void {
  let row: SqlRow | undefined
  try {
    row = driver.prepare(SCHEMA_VERSION_QUERY).get()
  } catch (cause) {
    // A SQLite file that is not one of ours: no `meta` table to read. Anything
    // else — corruption, an unreadable page — is a different problem and keeps
    // its own error.
    const message = cause instanceof Error ? cause.message : String(cause)
    if (!/no such table/i.test(message)) throw cause
    throw new LedgerNotFoundError(path, 'the file carries no izi-ledger schema', { cause })
  }
  if (row === undefined) {
    throw new LedgerNotFoundError(path, 'the schema is present but has no version row')
  }
  const found = Number(row.value)
  if (found !== SCHEMA_VERSION) throw new SchemaVersionMismatchError(found, SCHEMA_VERSION)
}
