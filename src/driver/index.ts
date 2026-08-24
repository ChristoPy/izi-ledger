import { DriverUnavailableError } from '../errors.js'
import { createBetterSqlite3Driver } from './better-sqlite3.js'
import { createBunDriver } from './bun.js'
import { createNodeDriver } from './node.js'
import type { Driver, DriverName, DriverOptions } from './types.js'

export type { Driver, DriverName, DriverOptions, SqlParam, SqlRow, Statement } from './types.js'

const FACTORIES: Record<DriverName, (o: DriverOptions) => Promise<Driver>> = {
  'bun:sqlite': createBunDriver,
  'node:sqlite': createNodeDriver,
  'better-sqlite3': createBetterSqlite3Driver,
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/**
 * Preference order. `bun:sqlite` first when running under Bun (it is the
 * fastest and always present there), then Node's built-in `node:sqlite`
 * (Node >= 22.5, zero install), then `better-sqlite3` for older Node.
 */
function defaultOrder(): DriverName[] {
  return isBun
    ? ['bun:sqlite', 'node:sqlite', 'better-sqlite3']
    : ['node:sqlite', 'better-sqlite3', 'bun:sqlite']
}

function envDriver(): DriverName | undefined {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.IZI_LEDGER_DRIVER
  if (!raw) return undefined
  if (raw in FACTORIES) return raw as DriverName
  throw new DriverUnavailableError(
    `IZI_LEDGER_DRIVER="${raw}" is not a known driver. Use one of: ${Object.keys(FACTORIES).join(', ')}.`,
  )
}

/**
 * Open a SQLite connection using the first driver that actually loads.
 *
 * `driver` forces a specific one (and surfaces the real load error instead of
 * silently falling through), which is what the driver matrix tests use.
 */
export async function resolveDriver(
  options: DriverOptions & { driver?: DriverName },
): Promise<Driver> {
  const forced = options.driver ?? envDriver()
  if (forced) {
    const factory = FACTORIES[forced]
    if (!factory) {
      throw new DriverUnavailableError(`Unknown SQLite driver "${forced}".`)
    }
    try {
      return await factory(options)
    } catch (cause) {
      throw new DriverUnavailableError(
        `SQLite driver "${forced}" was requested but could not be loaded: ${describe(cause)}`,
        { cause },
      )
    }
  }

  const attempts: string[] = []
  for (const name of defaultOrder()) {
    try {
      return await FACTORIES[name](options)
    } catch (cause) {
      attempts.push(`${name}: ${describe(cause)}`)
    }
  }

  throw new DriverUnavailableError(
    'No usable SQLite driver was found. Run on Bun, on Node >= 22.5 (built-in node:sqlite), ' +
      'or install the optional peer dependency `better-sqlite3`.\nTried:\n  ' +
      attempts.join('\n  '),
  )
}

/** Driver names that can be loaded in the current runtime. */
export async function availableDrivers(): Promise<DriverName[]> {
  const found: DriverName[] = []
  for (const name of Object.keys(FACTORIES) as DriverName[]) {
    try {
      const driver = await FACTORIES[name]({ path: ':memory:' })
      driver.close()
      found.push(name)
    } catch {
      // driver not present in this runtime
    }
  }
  return found
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
