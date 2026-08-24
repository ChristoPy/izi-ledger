import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, openLedger, payment, paymentLedger, tempDbPath } from './helpers.js'

afterEach(cleanup)

describe('balance cache', () => {
  test('a write warms the cache, so the next read never touches SQLite', async () => {
    const book = await paymentLedger()
    const before = (await book.stats()).cache
    await book.addMovement(payment(10_000, 250), 'p1')
    expect(await book.getBalance('user:1')).toBe(9_750)
    expect(await book.getBalance('fees')).toBe(250)
    const after = (await book.stats()).cache
    expect(after.hits - before.hits).toBe(2)
    expect(after.misses).toBe(before.misses)
  })

  test('the first read of a wallet is a miss, later reads are hits', async () => {
    const path = tempDbPath()
    const seed = await openLedger({ path })
    await seed.createWallet({ id: 'a', allowNegative: true })
    await seed.createWallet('b')
    await seed.addMovement(
      [
        { walletId: 'a', amount: -500 },
        { walletId: 'b', amount: 500 },
      ],
      'k',
    )
    await seed.close()

    const book = await openLedger({ path })
    expect((await book.stats()).cache.size).toBe(0)
    expect(await book.getBalance('b')).toBe(500)
    expect((await book.stats()).cache).toMatchObject({ size: 1, hits: 0, misses: 1 })
    expect(await book.getBalance('b')).toBe(500)
    expect((await book.stats()).cache).toMatchObject({ hits: 1, misses: 1 })
  })

  test('cacheSize: 0 disables caching entirely', async () => {
    const book = await paymentLedger({ cacheSize: 0 })
    await book.addMovement(payment(1_000, 0), 'p1')
    expect(await book.getBalance('user:1')).toBe(1_000)
    expect(await book.getBalance('user:1')).toBe(1_000)
    const cache = (await book.stats()).cache
    expect(cache.size).toBe(0)
    expect(cache.hits).toBe(0)
  })

  test('evicts least-recently-used wallets past the limit', async () => {
    const book = await openLedger({ cacheSize: 2 })
    for (const id of ['a', 'b', 'c']) await book.createWallet(id)
    expect((await book.stats()).cache.size).toBe(2)
    // 'a' was evicted by 'c'; reading it is a miss but still correct.
    expect(await book.getBalance('a')).toBe(0)
    expect((await book.stats()).cache.misses).toBe(1)
  })

  test('a rolled-back transaction never leaves its balances in the cache', async () => {
    const book = await paymentLedger()
    await book.addMovement(payment(1_000, 0), 'seed')
    expect(await book.getBalance('user:1')).toBe(1_000)

    await expect(
      book.addMovement(
        [
          { walletId: 'fees', amount: -100 },
          { walletId: 'user:1', amount: 100 },
        ],
        'rolled-back',
      ),
    ).rejects.toThrow()

    expect(await book.getBalance('user:1')).toBe(1_000)
    expect(await book.getBalance('fees')).toBe(0)
    expect((await book.verify()).ok).toBe(true)
  })

  test('drops the cache when another connection writes to the same file', async () => {
    const path = tempDbPath()
    const a = await openLedger({ path })
    await a.createWallet({ id: 'gateway', allowNegative: true })
    await a.createWallet('fees')
    expect(await a.getBalance('fees')).toBe(0)

    const b = await openLedger({ path })
    await b.addMovement(
      [
        { walletId: 'gateway', amount: -700 },
        { walletId: 'fees', amount: 700 },
      ],
      'external',
    )

    // Without the data_version guard this would still answer 0 from cache.
    expect(await a.getBalance('fees')).toBe(700)
    expect((await a.stats()).cache.invalidations).toBeGreaterThan(0)
  })

  test('its own writes do not invalidate the cache', async () => {
    const path = tempDbPath()
    const book = await openLedger({ path })
    await book.createWallet({ id: 'gateway', allowNegative: true })
    await book.createWallet('fees')
    const before = (await book.stats()).cache.invalidations
    for (let i = 0; i < 5; i++) {
      await book.addMovement(
        [
          { walletId: 'gateway', amount: -10 },
          { walletId: 'fees', amount: 10 },
        ],
        `k${i}`,
      )
      expect(await book.getBalance('fees')).toBe((i + 1) * 10)
    }
    expect((await book.stats()).cache.invalidations).toBe(before)
    expect((await book.stats()).cache.misses).toBe(0)
  })

  test('cached balances always agree with the database', async () => {
    const path = tempDbPath()
    const book = await openLedger({ path })
    await book.createWallet({ id: 'gateway', allowNegative: true })
    await book.createWallet('fees')
    for (let i = 0; i < 25; i++) {
      await book.addMovement(
        [
          { walletId: 'gateway', amount: -3 },
          { walletId: 'fees', amount: 3 },
        ],
        `k${i}`,
      )
    }
    const cached = await book.getBalance('fees')
    const fromDb = await openLedger({ path })
    expect(cached).toBe(await fromDb.getBalance('fees'))
    expect(cached).toBe(75)
  })
})
