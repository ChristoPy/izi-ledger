import { dynamicImport } from './import.js'
import type { Driver, DriverOptions, SqlParam, SqlRow, Statement } from './types.js'

interface BetterStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

interface BetterDatabase {
  exec(sql: string): void
  prepare(sql: string): BetterStatement
  close(): void
}

export async function createBetterSqlite3Driver(options: DriverOptions): Promise<Driver> {
  const mod = (await dynamicImport('better-sqlite3')) as {
    default?: new (path: string, opts?: Record<string, unknown>) => BetterDatabase
  } & (new (
    path: string,
    opts?: Record<string, unknown>,
  ) => BetterDatabase)
  const Database = (mod.default ?? mod) as new (
    path: string,
    opts?: Record<string, unknown>,
  ) => BetterDatabase
  const db = new Database(options.path, { readonly: !!options.readonly })

  return {
    name: 'better-sqlite3',
    exec: (sql) => db.exec(sql),
    prepare(sql): Statement {
      const stmt = db.prepare(sql)
      return {
        all: (...params: SqlParam[]) => stmt.all(...params) as SqlRow[],
        get: (...params: SqlParam[]) => (stmt.get(...params) ?? undefined) as SqlRow | undefined,
        run: (...params: SqlParam[]) => void stmt.run(...params),
      }
    },
    close: () => db.close(),
  }
}
