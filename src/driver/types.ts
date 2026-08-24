/** Values accepted as positional SQL parameters by every supported driver. */
export type SqlParam = string | number | bigint | null | Uint8Array

export type SqlRow = Record<string, unknown>

export interface Statement {
  /** Rows for a SELECT-like statement. */
  all(...params: SqlParam[]): SqlRow[]
  /** First row, or `undefined` when the statement matched nothing. */
  get(...params: SqlParam[]): SqlRow | undefined
  /** Execute a statement that returns no rows. */
  run(...params: SqlParam[]): void
}

export type DriverName = 'bun:sqlite' | 'node:sqlite' | 'better-sqlite3'

export interface Driver {
  readonly name: DriverName
  /** Run one or more statements with no parameters (DDL, BEGIN/COMMIT, PRAGMA). */
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

export interface DriverOptions {
  /** File path, or `:memory:` for an in-process database. */
  path: string
  readonly?: boolean
}

export type DriverFactory = (options: DriverOptions) => Promise<Driver>
