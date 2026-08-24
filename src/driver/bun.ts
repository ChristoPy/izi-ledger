import { dynamicImport } from './import.js'
import type { Driver, DriverOptions, SqlParam, SqlRow, Statement } from './types.js'

interface BunStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
  finalize?(): void
}

interface BunDatabase {
  exec(sql: string): void
  prepare(sql: string): BunStatement
  close(): void
}

export async function createBunDriver(options: DriverOptions): Promise<Driver> {
  const mod = (await dynamicImport('bun:sqlite')) as {
    Database: new (path: string, opts?: Record<string, unknown>) => BunDatabase
  }
  const db = new mod.Database(options.path, {
    create: !options.readonly,
    readwrite: !options.readonly,
    readonly: !!options.readonly,
  })

  return {
    name: 'bun:sqlite',
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
