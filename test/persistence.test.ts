import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cleanup, openLedger, payment, raw, tempDbPath } from './helpers.js'

afterEach(cleanup)

describe('durability across reopens', () => {
  test('balances, movements and wallets survive a close/reopen cycle', async () => {
    const path = tempDbPath()
    const first = await openLedger({ path })
    await first.createWallet({ id: 'gateway', allowNegative: true, metadata: { kind: 'system' } })
    await first.createWallet('user:1')
    await first.createWallet('fees')
    await first.addMovement(payment(10_000, 250), 'p1')
    const statsBefore = await first.stats()
    await first.close()

    expect(existsSync(path)).toBe(true)

    const second = await openLedger({ path })
    expect(await second.getBalances(['gateway', 'user:1', 'fees'])).toEqual({
      gateway: -10_000,
      'user:1': 9_750,
      fees: 250,
    })
    expect((await second.getWallet('gateway')).metadata).toEqual({ kind: 'system' })
    const statsAfter = await second.stats()
    expect(statsAfter.headHash).toBe(statsBefore.headHash)
    expect(statsAfter.lastSeq).toBe(statsBefore.lastSeq)
    expect((await second.verify()).ok).toBe(true)
  })

  test('the hash chain continues across a reopen', async () => {
    const path = tempDbPath()
    const first = await openLedger({ path })
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

    const second = await openLedger({ path })
    const tx = await second.addMovement(
      [
        { walletId: 'a', amount: -100 },
        { walletId: 'b', amount: 100 },
      ],
      'p2',
    )
    expect(tx.movements[0]!.prevHash).toBe(head)
    expect(tx.movements[0]!.seq).toBe(3)
    expect((await second.verify()).ok).toBe(true)
  })

  test('an in-memory ledger is not shared between instances', async () => {
    const a = await openLedger({ path: ':memory:' })
    const b = await openLedger({ path: ':memory:' })
    await a.createWallet('only-in-a')
    expect((await b.stats()).wallets).toBe(0)
  })
})

describe('atomicity', () => {
  test('a rejected transaction leaves no trace in any table', async () => {
    const path = tempDbPath()
    const book = await openLedger({ path })
    await book.createWallet({ id: 'gateway', allowNegative: true })
    await book.createWallet('user:1')
    await book.createWallet('fees')
    await book.addMovement(payment(1_000, 0), 'seed')
    const before = await book.stats()

    await expect(
      book.addMovement(
        [
          { walletId: 'gateway', amount: -500 },
          { walletId: 'user:1', amount: 900 },
          { walletId: 'fees', amount: -400 },
        ],
        'doomed',
      ),
    ).rejects.toThrow()

    const after = await book.stats()
    expect(after.movements).toBe(before.movements)
    expect(after.transactions).toBe(before.transactions)
    expect(after.headHash).toBe(before.headHash)
    expect(after.lastSeq).toBe(before.lastSeq)
    expect(await book.getTransaction('doomed')).toBeNull()
    expect((await book.verify()).ok).toBe(true)

    // And the idempotency key is free to be reused by a corrected request.
    await expect(book.addMovement(payment(500, 100), 'doomed')).resolves.toBeDefined()
  })

  test('a COMMIT that fails rolls back instead of stranding the transaction', async () => {
    const path = tempDbPath()
    const book = await openLedger({ path })
    await book.createWallet({ id: 'a', allowNegative: true })
    await book.createWallet('b')
    const entries = [
      { walletId: 'a', amount: -100 },
      { walletId: 'b', amount: 100 },
    ]

    // A full disk, a lost lock or an I/O error surfaces at COMMIT, which is the
    // one statement outside the transaction helper's try. Fail it once.
    const driver = (book as unknown as { driver: { exec(sql: string): void } }).driver
    const realExec = driver.exec.bind(driver)
    let broken = true
    driver.exec = (sql: string) => {
      if (broken && sql.startsWith('COMMIT')) {
        broken = false
        throw new Error('disk I/O error')
      }
      realExec(sql)
    }

    await expect(book.addMovement(entries, 'doomed')).rejects.toThrow('disk I/O error')
    driver.exec = realExec

    // The handle has to survive: a transaction left open fails every later
    // write with "cannot start a transaction within a transaction".
    await expect(book.addMovement(entries, 'next')).resolves.toBeDefined()
    expect(await book.getBalance('b')).toBe(100)
    expect((await book.stats()).movements).toBe(2)
    expect((await book.verify()).ok).toBe(true)
  })

  test('the failure happens before any row is written, not after', async () => {
    const path = tempDbPath()
    const book = await openLedger({ path })
    await book.createWallet({ id: 'a', allowNegative: true })
    await book.createWallet('b')
    await expect(
      book.addMovement(
        [
          { walletId: 'a', amount: -100 },
          { walletId: 'b', amount: -100 },
          { walletId: 'a', amount: 200 },
        ],
        'partial',
      ),
    ).rejects.toThrow()
    expect(raw(path, (db) => db.query('SELECT COUNT(*) AS n FROM movements').get())).toEqual({
      n: 0,
    })
    expect(raw(path, (db) => db.query('SELECT COUNT(*) AS n FROM transactions').get())).toEqual({
      n: 0,
    })
  })
})

describe('crash safety', () => {
  test('a SIGKILL mid-write leaves a consistent, verifiable ledger', async () => {
    const path = tempDbPath()
    const child = Bun.spawn(
      // fileURLToPath, not URL.pathname: the latter is percent-encoded and keeps
      // a leading slash on Windows drive letters.
      ['bun', 'run', fileURLToPath(new URL('./fixtures/crash-writer.ts', import.meta.url)), path],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), stdout: 'pipe', stderr: 'pipe' },
    )

    // Wait until a handful of transactions have definitely committed, then pull
    // the plug without giving the process any chance to clean up.
    let committed = 0
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      committed += decoder
        .decode(chunk)
        .split('\n')
        .filter((l) => l.startsWith('committed')).length
      if (committed >= 8) break
    }
    child.kill('SIGKILL')
    await child.exited

    expect(committed).toBeGreaterThanOrEqual(8)

    const book = await openLedger({ path })
    const result = await book.verify()
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)

    const stats = await book.stats()
    // Every committed transaction is a whole pair of movements; nothing is torn.
    expect(stats.movements % 2).toBe(0)
    expect(stats.movements).toBe(stats.transactions * 2)
    expect(stats.movements / 2).toBeGreaterThanOrEqual(committed)
    expect(await book.getBalance('fees')).toBe((stats.movements / 2) * 10)
    expect(await book.getBalance('gateway')).toBe(-(stats.movements / 2) * 10)

    // And the ledger keeps working from where it stopped.
    const next = await book.addMovement(
      [
        { walletId: 'gateway', amount: -10 },
        { walletId: 'fees', amount: 10 },
      ],
      'after-crash',
    )
    expect(next.movements[0]!.seq).toBe(stats.lastSeq + 1)
    expect((await book.verify()).ok).toBe(true)
  }, 30_000)
})
