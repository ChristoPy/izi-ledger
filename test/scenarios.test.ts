import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, openLedger, tempDbPath } from './helpers.js'

afterEach(cleanup)

/** A small chart of accounts, the way a payments product would lay it out. */
async function book() {
  const l = await openLedger({ path: tempDbPath() })
  await l.createWallet({ id: 'external:pix', allowNegative: true, metadata: { type: 'clearing' } })
  await l.createWallet({ id: 'revenue:fees', allowNegative: true, metadata: { type: 'revenue' } })
  await l.createWallet({ id: 'user:alice' })
  await l.createWallet({ id: 'user:bob' })
  return l
}

describe('payments scenarios', () => {
  test('deposit with a fee splits into three entries', async () => {
    const l = await book()
    await l.addMovement(
      [
        { walletId: 'external:pix', amount: -100_00 },
        { walletId: 'user:alice', amount: 97_50 },
        { walletId: 'revenue:fees', amount: 2_50 },
      ],
      { idempotencyKey: 'deposit:1', metadata: { psp: 'pix', endToEndId: 'E123' } },
    )
    expect(await l.getBalances(['user:alice', 'revenue:fees', 'external:pix'])).toEqual({
      'user:alice': 9_750,
      'revenue:fees': 250,
      'external:pix': -10_000,
    })
  })

  test('transfer between users with a fee stays zero-sum', async () => {
    const l = await book()
    await l.addMovement(
      [
        { walletId: 'external:pix', amount: -100_00 },
        { walletId: 'user:alice', amount: 100_00 },
      ],
      'deposit:1',
    )
    await l.addMovement(
      [
        { walletId: 'user:alice', amount: -30_00 },
        { walletId: 'user:bob', amount: 29_00 },
        { walletId: 'revenue:fees', amount: 1_00 },
      ],
      'transfer:1',
    )
    expect(await l.getBalances(['user:alice', 'user:bob', 'revenue:fees'])).toEqual({
      'user:alice': 7_000,
      'user:bob': 2_900,
      'revenue:fees': 100,
    })
    const total = (await l.listMovements()).reduce((sum, m) => sum + m.amount, 0)
    expect(total).toBe(0)
  })

  test('a refund is a new movement, never a deletion', async () => {
    const l = await book()
    await l.addMovement(
      [
        { walletId: 'external:pix', amount: -50_00 },
        { walletId: 'user:alice', amount: 48_00 },
        { walletId: 'revenue:fees', amount: 2_00 },
      ],
      'deposit:1',
    )
    await l.addMovement(
      [
        { walletId: 'user:alice', amount: -48_00 },
        { walletId: 'revenue:fees', amount: -2_00 },
        { walletId: 'external:pix', amount: 50_00 },
      ],
      { idempotencyKey: 'refund:deposit:1', metadata: { refunds: 'deposit:1' } },
    )
    expect(await l.getBalances(['user:alice', 'revenue:fees', 'external:pix'])).toEqual({
      'user:alice': 0,
      'revenue:fees': 0,
      'external:pix': 0,
    })
    // The history is append-only: both the deposit and the refund are on record.
    expect((await l.listMovements({ walletId: 'user:alice' })).map((m) => m.amount)).toEqual([
      4_800, -4_800,
    ])
    expect((await l.verify()).ok).toBe(true)
  })

  test('a wallet statement reconstructs the balance from its own movements', async () => {
    const l = await book()
    await l.addMovement(
      [
        { walletId: 'external:pix', amount: -100_00 },
        { walletId: 'user:alice', amount: 100_00 },
      ],
      'd1',
    )
    for (let i = 0; i < 5; i++) {
      await l.addMovement(
        [
          { walletId: 'user:alice', amount: -10_00 },
          { walletId: 'user:bob', amount: 10_00 },
        ],
        `t${i}`,
      )
    }
    const statement = await l.listMovements({ walletId: 'user:alice' })
    let running = 0
    for (const movement of statement) {
      running += movement.amount
      expect(movement.balance).toBe(running)
    }
    expect(running).toBe(await l.getBalance('user:alice'))
    expect(statement.map((m) => m.walletSeq)).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('volume', () => {
  test('2000 transactions stay zero-sum, gap-free and verifiable', async () => {
    const l = await openLedger({ path: tempDbPath(), durability: 'normal' })
    await l.createWallet({ id: 'source', allowNegative: true })
    await l.createWallet('dest')
    await l.createWallet('fee')

    const count = 2_000
    for (let i = 0; i < count; i++) {
      await l.addMovement(
        [
          { walletId: 'source', amount: -100 },
          { walletId: 'dest', amount: 97 },
          { walletId: 'fee', amount: 3 },
        ],
        `bulk:${i}`,
      )
    }

    expect(await l.getBalances(['source', 'dest', 'fee'])).toEqual({
      source: -100 * count,
      dest: 97 * count,
      fee: 3 * count,
    })

    const result = await l.verify()
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(count * 3)

    const stats = await l.stats()
    expect(stats.lastSeq).toBe(count * 3)
    expect(stats.transactions).toBe(count)
    // Reads were served from cache throughout: only the initial fill missed.
    expect(stats.cache.misses).toBeLessThanOrEqual(3)
  }, 60_000)

  test('handles amounts at the edge of the safe integer range', async () => {
    const l = await openLedger()
    await l.createWallet({ id: 'big', allowNegative: true })
    await l.createWallet('sink')
    const huge = Number.MAX_SAFE_INTEGER
    await l.addMovement(
      [
        { walletId: 'big', amount: -huge },
        { walletId: 'sink', amount: huge },
      ],
      'huge',
    )
    expect(await l.getBalance('sink')).toBe(huge)
    // One more unit would leave the exact-integer range, so it is refused.
    await expect(
      l.addMovement(
        [
          { walletId: 'big', amount: -1 },
          { walletId: 'sink', amount: 1 },
        ],
        'overflow',
      ),
    ).rejects.toThrow(/safe integer range/)
    expect((await l.verify()).ok).toBe(true)
  })
})
