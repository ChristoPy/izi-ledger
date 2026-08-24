import type { Driver } from './driver/index.js'
import { SchemaVersionMismatchError } from './errors.js'

export const SCHEMA_VERSION = 2

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

CREATE INDEX IF NOT EXISTS movements_wallet_seq ON movements (wallet_id, seq);
CREATE INDEX IF NOT EXISTS movements_tx         ON movements (tx_id);
CREATE UNIQUE INDEX IF NOT EXISTS movements_wallet_pos ON movements (wallet_id, wallet_seq);
`

export interface PragmaOptions {
  durability: 'full' | 'normal'
  busyTimeoutMs: number
}

export function applyPragmas(driver: Driver, options: PragmaOptions): void {
  // WAL lets readers work while a writer holds the write lock; it is a no-op
  // (silently "memory") for :memory: databases.
  driver.exec(`PRAGMA journal_mode = WAL;`)
  driver.exec(`PRAGMA synchronous = ${options.durability === 'full' ? 'FULL' : 'NORMAL'};`)
  driver.exec(`PRAGMA foreign_keys = ON;`)
  driver.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))};`)
  // Every write is a single BEGIN IMMEDIATE transaction, so we want the write
  // lock taken up front rather than after a deferred read upgrade fails.
  driver.exec(`PRAGMA trusted_schema = OFF;`)
}

export function applySchema(driver: Driver): void {
  driver.exec('BEGIN IMMEDIATE;')
  try {
    driver.exec(DDL)
    const row = driver.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()
    if (row === undefined) {
      const insert = driver.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
      insert.run('schema_version', String(SCHEMA_VERSION))
      insert.run('last_seq', '0')
      insert.run('head_hash', null)
      insert.run('last_timestamp', '0')
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
