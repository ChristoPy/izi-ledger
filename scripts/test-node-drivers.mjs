/**
 * Conformance suite for the published build, run under Node against every
 * driver Node can load. `bun test` covers bun:sqlite; this covers the rest,
 * and doubles as a check that dist/ actually works outside Bun.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const dist = pathToFileURL(join(process.cwd(), 'dist/esm/index.js')).href
const { ledger, IdempotencyConflictError, InsufficientFundsError } = await import(dist)

/**
 * better-sqlite3 v11 aborts inside Database::~Database() on Node 24, once the
 * environment has already been torn down. v12 fixes it but publishes no Node 20
 * prebuild, and Node 20 is the runtime that has no built-in node:sqlite — so
 * v11 is what a Node 20 install actually gets.
 *
 * Nothing is lost by not running it here: on Node >= 22.5 the built-in
 * node:sqlite wins driver resolution and the addon is never reached unless it
 * is forced. This is checked before probing, because merely opening and closing
 * a Database is enough to plant the abort.
 */
function betterSqlite3Unsupported() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 24) return null
  let installed
  try {
    installed = createRequireHere()('better-sqlite3/package.json').version
  } catch {
    return 'better-sqlite3 is not installed'
  }
  if (Number(installed.split('.')[0]) >= 12) return null
  return `better-sqlite3 ${installed} aborts on Node ${process.versions.node}; needs >= 12`
}

function createRequireHere() {
  return createRequire(join(process.cwd(), 'package.json'))
}

const dirs = []
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'izi-ledger-node-'))
  dirs.push(dir)
  return join(dir, 'ledger.db')
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const skipReason = betterSqlite3Unsupported()
const drivers = []
for (const name of ['node:sqlite', 'better-sqlite3']) {
  if (name === 'better-sqlite3' && skipReason) {
    console.log(`skipping better-sqlite3: ${skipReason}`)
    continue
  }
  try {
    const probe = await ledger({ driver: name, path: ':memory:' })
    await probe.close()
    drivers.push(name)
  } catch (error) {
    console.log(`skipping ${name}: ${error.message.split('\n')[0]}`)
  }
}
assert.ok(drivers.length > 0, 'expected at least one Node-capable SQLite driver')
console.log(`running the conformance suite against: ${drivers.join(', ')}`)

for (const driver of drivers) {
  describe(driver, () => {
    test('records a zero-sum payment and reads balances back', async () => {
      const book = await ledger({ driver, path: ':memory:' })
      await book.createWallet({ id: 'gateway', allowNegative: true })
      await book.createWallet('user:1')
      await book.createWallet('fees')
      const tx = await book.addMovement(
        [
          { walletId: 'gateway', amount: -10_000 },
          { walletId: 'user:1', amount: 9_750, metadata: { orderId: 'o1' } },
          { walletId: 'fees', amount: 250 },
        ],
        { idempotencyKey: 'pay:1', metadata: { source: 'pix' } },
      )
      assert.equal(tx.movements.length, 3)
      assert.equal(tx.movements[1].metadata.orderId, 'o1')
      assert.deepEqual(await book.getBalances(['gateway', 'user:1', 'fees']), {
        gateway: -10_000,
        'user:1': 9_750,
        fees: 250,
      })
      assert.deepEqual(await book.verify(), { ok: true, checked: 3, issues: [] })
      await book.close()
    })

    test('is idempotent and detects key reuse', async () => {
      const book = await ledger({ driver, path: ':memory:' })
      await book.createWallet({ id: 'a', allowNegative: true })
      await book.createWallet('b')
      const entries = [
        { walletId: 'a', amount: -100 },
        { walletId: 'b', amount: 100 },
      ]
      const first = await book.addMovement(entries, 'k')
      const second = await book.addMovement(entries, 'k')
      assert.equal(second.replayed, true)
      assert.equal(second.id, first.id)
      assert.equal(await book.getBalance('b'), 100)
      await assert.rejects(
        () =>
          book.addMovement(
            [
              { walletId: 'a', amount: -1 },
              { walletId: 'b', amount: 1 },
            ],
            'k',
          ),
        IdempotencyConflictError,
      )
      await book.close()
    })

    test('serialises concurrent writes and stays verifiable', async () => {
      const book = await ledger({ driver, path: tempDb(), durability: 'normal' })
      await book.createWallet({ id: 'a', allowNegative: true })
      await book.createWallet('b')
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          book.addMovement(
            [
              { walletId: 'a', amount: -7 },
              { walletId: 'b', amount: 7 },
            ],
            `k${i}`,
          ),
        ),
      )
      assert.equal(await book.getBalance('b'), 700)
      const movements = await book.listMovements()
      assert.equal(movements.length, 200)
      assert.deepEqual(
        movements.map((m) => m.seq),
        Array.from({ length: 200 }, (_, i) => i + 1),
      )
      assert.equal((await book.verify()).ok, true)
      await book.close()
    })

    test('blocks negative balances and rolls the transaction back', async () => {
      const book = await ledger({ driver, path: ':memory:' })
      await book.createWallet('a')
      await book.createWallet('b')
      await assert.rejects(
        () =>
          book.addMovement(
            [
              { walletId: 'a', amount: -1 },
              { walletId: 'b', amount: 1 },
            ],
            'overdraw',
          ),
        InsufficientFundsError,
      )
      assert.equal((await book.stats()).movements, 0)
      assert.equal((await book.verify()).ok, true)
      await book.close()
    })

    test('persists and keeps chaining across a reopen', async () => {
      const path = tempDb()
      const first = await ledger({ driver, path })
      await first.createWallet({ id: 'a', allowNegative: true })
      await first.createWallet('b')
      await first.addMovement(
        [
          { walletId: 'a', amount: -100 },
          { walletId: 'b', amount: 100 },
        ],
        'p1',
      )
      const head = (await first.stats()).headHash
      await first.close()

      const second = await ledger({ driver, path, verifyOnOpen: true })
      const tx = await second.addMovement(
        [
          { walletId: 'a', amount: -100 },
          { walletId: 'b', amount: 100 },
        ],
        'p2',
      )
      assert.equal(tx.movements[0].prevHash, head)
      assert.equal(await second.getBalance('b'), 200)
      assert.equal((await second.verify('b')).ok, true)
      await second.close()
    })

    test('caches balances and drops the cache on an external write', async () => {
      const path = tempDb()
      const a = await ledger({ driver, path })
      await a.createWallet({ id: 'gw', allowNegative: true })
      await a.createWallet('fees')
      assert.equal(await a.getBalance('fees'), 0)

      const b = await ledger({ driver, path })
      await b.addMovement(
        [
          { walletId: 'gw', amount: -700 },
          { walletId: 'fees', amount: 700 },
        ],
        'external',
      )
      assert.equal(await a.getBalance('fees'), 700)
      await a.close()
      await b.close()
    })
  })
}

describe('published build', () => {
  test('the CommonJS entrypoint works too', async () => {
    const { createRequire } = await import('node:module')
    const require = createRequire(join(process.cwd(), 'package.json'))
    const cjs = require('./dist/cjs/index.js')
    const book = await cjs.ledger({ path: ':memory:' })
    await book.createWallet({ id: 'a', allowNegative: true })
    await book.createWallet('b')
    await book.addMovement(
      [
        { walletId: 'a', amount: -5 },
        { walletId: 'b', amount: 5 },
      ],
      'cjs',
    )
    assert.equal(await book.getBalance('b'), 5)
    assert.equal((await book.verify()).ok, true)
    assert.equal(typeof cjs.default, 'function')
    assert.ok(cjs.LedgerError)
    await book.close()
  })

  test('the checkpoint and audit subpaths resolve', async () => {
    const { pathToFileURL: toUrl } = await import('node:url')
    const signing = await import(toUrl(join(process.cwd(), 'dist/esm/signing.js')).href)
    const { audit } = await import(toUrl(join(process.cwd(), 'dist/esm/audit.js')).href)

    const path = tempDb()
    const { privateKey, publicKey } = signing.generateSigningKeyPair()
    const book = await ledger({
      path,
      signer: signing.ed25519Signer({ keyId: 'k1', privateKey }),
    })
    await book.createWallet({ id: 'a', allowNegative: true })
    await book.createWallet('b')
    await book.addMovement(
      [
        { walletId: 'a', amount: -100 },
        { walletId: 'b', amount: 100 },
      ],
      'p1',
    )
    const anchor = await book.checkpoint()
    assert.equal(signing.verifyCheckpointSignature(anchor, { k1: publicKey }).ok, true)
    await book.close()

    const report = await audit({ path, anchors: [anchor], publicKeys: { k1: publicKey } })
    assert.equal(report.ok, true)
    assert.equal(report.anchorsChecked, 1)
    assert.equal(report.signaturesChecked, 1)
    assert.deepEqual(report.totals, { BRL: 0 })
  })

  test('the audit command runs from the built bin', async () => {
    const { execFileSync } = await import('node:child_process')
    const path = tempDb()
    const book = await ledger({ path })
    await book.createWallet({ id: 'a', allowNegative: true })
    await book.createWallet('b')
    await book.addMovement(
      [
        { walletId: 'a', amount: -1 },
        { walletId: 'b', amount: 1 },
      ],
      'p1',
    )
    await book.close()

    const out = execFileSync(
      process.execPath,
      [join(process.cwd(), 'dist/esm/bin.js'), 'audit', path],
      {
        encoding: 'utf8',
      },
    )
    assert.match(out, /VERIFIED/)
  })

  test('both module systems ship their own declarations', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    // A .d.ts under dist/cjs is read as CommonJS types because that folder is
    // marked { "type": "commonjs" } — which is what keeps `require()` callers
    // from resolving ESM declarations for a CJS file.
    assert.ok(existsSync(join(process.cwd(), 'dist/esm/index.d.ts')))
    assert.ok(existsSync(join(process.cwd(), 'dist/cjs/index.d.ts')))
    for (const name of ['signing', 'audit']) {
      assert.ok(existsSync(join(process.cwd(), `dist/esm/${name}.d.ts`)), `esm ${name} types`)
      assert.ok(existsSync(join(process.cwd(), `dist/cjs/${name}.d.ts`)), `cjs ${name} types`)
    }
    assert.equal(
      JSON.parse(readFileSync(join(process.cwd(), 'dist/cjs/package.json'), 'utf8')).type,
      'commonjs',
    )
    assert.equal(
      JSON.parse(readFileSync(join(process.cwd(), 'dist/esm/package.json'), 'utf8')).type,
      'module',
    )
  })
})
