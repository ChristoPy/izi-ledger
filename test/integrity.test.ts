import { afterEach, describe, expect, test } from 'bun:test'
import { IntegrityError, ledger, WalletNotFoundError } from '../src/index.js'
import { cleanup, openLedger, payment, raw, tempDbPath } from './helpers.js'

afterEach(cleanup)

/** A file-backed ledger with a few transactions, closed and ready to tamper with. */
async function sealedLedger(txCount = 3): Promise<string> {
  const path = tempDbPath()
  const book = await openLedger({ path })
  await book.createWallet({ id: 'gateway', allowNegative: true })
  await book.createWallet('user:1')
  await book.createWallet('fees')
  for (let i = 0; i < txCount; i++) {
    await book.addMovement(payment(10_000, 250), { idempotencyKey: `p${i}`, metadata: { i } })
  }
  await book.close()
  return path
}

async function verifyAfter(
  path: string,
  tamper: (db: import('bun:sqlite').Database) => void,
  walletId?: string,
) {
  raw(path, tamper)
  const book = await openLedger({ path })
  return book.verify(walletId)
}

describe('verify — healthy ledger', () => {
  test('passes on an untouched ledger', async () => {
    const path = await sealedLedger(5)
    const book = await openLedger({ path })
    const result = await book.verify()
    expect(result).toEqual({ ok: true, checked: 15, issues: [] })
  })

  test('passes per wallet', async () => {
    const path = await sealedLedger(5)
    const book = await openLedger({ path })
    for (const id of ['gateway', 'user:1', 'fees']) {
      const result = await book.verify(id)
      expect(result.ok).toBe(true)
      expect(result.checked).toBe(5)
    }
  })

  test('passes on an empty ledger', async () => {
    const book = await openLedger()
    expect(await book.verify()).toEqual({ ok: true, checked: 0, issues: [] })
  })

  test('throws for an unknown wallet', async () => {
    const book = await openLedger()
    await expect(book.verify('ghost')).rejects.toThrow(WalletNotFoundError)
  })
})

describe('verify — tamper detection', () => {
  test('detects a rewritten amount', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run('UPDATE movements SET amount = amount - 1 WHERE seq = 2')
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Hash mismatch'))).toBe(true)
  })

  test('detects a rewritten running balance', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run('UPDATE movements SET balance = balance + 1000 WHERE seq = 3')
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Running balance mismatch'))).toBe(true)
    expect(result.issues.some((i) => i.reason.includes('Hash mismatch'))).toBe(true)
  })

  test('detects a back-dated timestamp', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run('UPDATE movements SET timestamp = 1 WHERE seq = 1')
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Hash mismatch'))).toBe(true)
  })

  test('detects edited movement metadata', async () => {
    const path = tempDbPath()
    const book = await openLedger({ path })
    await book.createWallet({ id: 'a', allowNegative: true })
    await book.createWallet('b')
    await book.addMovement(
      [
        { walletId: 'a', amount: -100, metadata: { note: 'original' } },
        { walletId: 'b', amount: 100 },
      ],
      'k',
    )
    await book.close()

    const result = await verifyAfter(path, (db) => {
      db.run(`UPDATE movements SET metadata = '{"note":"forged"}' WHERE seq = 1`)
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Hash mismatch'))).toBe(true)
  })

  test('detects a deleted movement', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run('PRAGMA foreign_keys = OFF')
      db.run('DELETE FROM movements WHERE seq = 5')
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Gap in the global sequence'))).toBe(true)
    expect(result.issues.some((i) => i.reason.includes('Broken global chain'))).toBe(true)
  })

  test('detects a re-pointed prevHash', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run(
        `UPDATE movements SET prev_hash = (SELECT hash FROM movements WHERE seq = 1) WHERE seq = 4`,
      )
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Broken global chain'))).toBe(true)
  })

  test('detects a re-pointed prevWalletHash', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run(`UPDATE movements SET prev_wallet_hash = NULL WHERE seq = 4`)
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Broken wallet chain'))).toBe(true)
  })

  test('detects a doctored wallet balance column', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run(`UPDATE wallets SET balance = 999999 WHERE id = 'user:1'`)
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Stored balance for "user:1"'))).toBe(true)
  })

  test('detects a doctored wallet head hash', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run(`UPDATE wallets SET head_hash = NULL WHERE id = 'fees'`)
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('Stored head hash for "fees"'))).toBe(true)
  })

  test('detects edited transaction metadata', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run(`UPDATE transactions SET metadata = '{"i":99}' WHERE idempotency_key = 'p1'`)
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('request fingerprint'))).toBe(true)
  })

  test('detects a rewritten idempotency key', async () => {
    // The key is stored once, on the transaction, and every movement hash
    // covers it — so rewriting it invalidates the whole transaction's chain
    // instead of silently disabling replay protection.
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run(`UPDATE transactions SET idempotency_key = 'forged' WHERE idempotency_key = 'p1'`)
    })
    expect(result.ok).toBe(false)
    expect(result.issues.filter((i) => i.reason.includes('Hash mismatch'))).toHaveLength(3)
  })

  test('a rewritten key cannot be used to replay a settled transaction', async () => {
    const path = await sealedLedger(1)
    raw(path, (db) => db.run(`UPDATE transactions SET idempotency_key = 'forged'`))

    const book = await openLedger({ path })
    expect((await book.verify()).ok).toBe(false)
    // The original key now looks unused, so a retry would go through — which is
    // exactly why verify() has to be able to see the edit.
    expect(await book.getTransaction('p0')).toBeNull()
  })

  test('the idempotency key is not duplicated onto movement rows', async () => {
    const path = await sealedLedger(1)
    const columns = raw(
      path,
      (db) => db.query('PRAGMA table_info(movements)').all() as Array<{ name: string }>,
    )
    expect(columns.map((c) => c.name)).not.toContain('idempotency_key')
    // It still reaches the caller, rejoined from the transaction.
    const book = await openLedger({ path })
    expect((await book.listMovements())[0]!.idempotencyKey).toBe('p0')
    expect(await book.listMovements({ idempotencyKey: 'p0' })).toHaveLength(3)
  })

  test('detects a ledger head that no longer matches the last movement', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run(`UPDATE meta SET value = 'deadbeef' WHERE key = 'head_hash'`)
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('head hash'))).toBe(true)
  })

  test('per-wallet verification catches tampering inside that wallet', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(
      path,
      (db) => db.run(`UPDATE movements SET amount = 1 WHERE wallet_id = 'fees' AND wallet_seq = 2`),
      'fees',
    )
    expect(result.ok).toBe(false)
    expect(result.checked).toBe(3)
    expect(result.issues.some((i) => i.reason.includes('Hash mismatch'))).toBe(true)
    expect(result.issues.every((i) => i.walletId === 'fees')).toBe(true)
  })

  test('a tampered zero-sum total is reported', async () => {
    const path = await sealedLedger()
    const result = await verifyAfter(path, (db) => {
      db.run('UPDATE movements SET amount = amount + 5 WHERE seq = 2')
    })
    expect(result.issues.some((i) => i.reason.includes('not zero-sum'))).toBe(true)
  })
})

describe('verifyOnOpen', () => {
  test('opens a healthy ledger', async () => {
    const path = await sealedLedger()
    const book = await openLedger({ path, verifyOnOpen: true })
    expect(book.closed).toBe(false)
  })

  test('refuses to open a corrupted ledger', async () => {
    const path = await sealedLedger()
    raw(path, (db) => db.run('UPDATE movements SET amount = 7 WHERE seq = 2'))
    await expect(ledger({ path, verifyOnOpen: true })).rejects.toThrow(IntegrityError)
  })
})
