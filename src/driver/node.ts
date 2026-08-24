import { dynamicImport } from './import.js'
import type { Driver, DriverOptions, SqlParam, SqlRow, Statement } from './types.js'

interface NodeStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

interface NodeDatabase {
  exec(sql: string): void
  prepare(sql: string): NodeStatement
  close(): void
}

export async function createNodeDriver(options: DriverOptions): Promise<Driver> {
  const mod = (await dynamicImport('node:sqlite')) as {
    DatabaseSync: new (path: string, opts?: Record<string, unknown>) => NodeDatabase
  }
  const db = new mod.DatabaseSync(options.path, {
    open: true,
    readOnly: !!options.readonly,
  })

  return {
    name: 'node:sqlite',
    exec: (sql) => db.exec(sql),
    prepare(sql): Statement {
      const stmt = db.prepare(sql)
      return {
        // node:sqlite hands back null-prototype objects; normalise so callers can
        // treat rows as ordinary records (spread, Object.keys, structuredClone).
        all: (...params: SqlParam[]) =>
          (stmt.all(...params) as SqlRow[]).map((row) => ({ ...row })),
        get: (...params: SqlParam[]) => {
          const row = stmt.get(...params) as SqlRow | undefined | null
          return row == null ? undefined : { ...row }
        },
        run: (...params: SqlParam[]) => void stmt.run(...params),
      }
    },
    close: () => db.close(),
  }
}
