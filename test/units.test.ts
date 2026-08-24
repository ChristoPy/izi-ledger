import { describe, expect, test } from 'bun:test'
import { addExact, assertAmount } from '../src/amount.js'
import { BalanceCache } from '../src/cache.js'
import { canonicalJson, movementHash, requestFingerprint } from '../src/canonical.js'
import { InvalidAmountError, InvalidArgumentError } from '../src/errors.js'
import { Mutex } from '../src/mutex.js'

describe('canonicalJson', () => {
  test('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  test('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  test('is stable regardless of insertion order', () => {
    const a = { x: 1, y: [{ q: 1, p: 2 }] }
    const b = { y: [{ p: 2, q: 1 }], x: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  test('drops undefined properties and normalises -0', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson(-0)).toBe('0')
  })

  test('encodes dates and bigints as strings', () => {
    expect(canonicalJson(new Date('2024-01-01T00:00:00.000Z'))).toBe('"2024-01-01T00:00:00.000Z"')
    expect(canonicalJson(10n)).toBe('"10"')
  })

  test('rejects values that cannot be hashed deterministically', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(InvalidArgumentError)
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(InvalidArgumentError)
    expect(() => canonicalJson({ a: () => 1 })).toThrow(InvalidArgumentError)
    expect(() => canonicalJson({ a: Symbol('s') })).toThrow(InvalidArgumentError)
  })

  test('refuses runaway nesting', () => {
    let deep: unknown = 1
    for (let i = 0; i < 40; i++) deep = { deep }
    expect(() => canonicalJson(deep)).toThrow(InvalidArgumentError)
  })
})

describe('movementHash', () => {
  const base = {
    seq: 1,
    txId: 'tx',
    idempotencyKey: 'k',
    walletId: 'w',
    currency: 'BRL',
    amount: -100,
    balance: -100,
    timestamp: 1_700_000_000_000,
    walletSeq: 1,
    prevHash: null,
    prevWalletHash: null,
    metadata: null,
  }

  test('is deterministic', () => {
    expect(movementHash(base)).toBe(movementHash({ ...base }))
    expect(movementHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('changes when any field changes', () => {
    const reference = movementHash(base)
    const mutations = [
      { seq: 2 },
      { txId: 'other' },
      { idempotencyKey: 'other' },
      { walletId: 'other' },
      { currency: 'USD' },
      { amount: -101 },
      { balance: -99 },
      { timestamp: 1_700_000_000_001 },
      { walletSeq: 2 },
      { prevHash: 'a'.repeat(64) },
      { prevWalletHash: 'b'.repeat(64) },
      { metadata: { a: 1 } },
    ]
    for (const mutation of mutations) {
      expect(movementHash({ ...base, ...mutation })).not.toBe(reference)
    }
  })

  test('ignores metadata key order', () => {
    expect(movementHash({ ...base, metadata: { a: 1, b: 2 } })).toBe(
      movementHash({ ...base, metadata: { b: 2, a: 1 } }),
    )
  })
})

describe('requestFingerprint', () => {
  test('is order sensitive over entries but not over metadata keys', () => {
    const entries = [
      { walletId: 'a', amount: -1 },
      { walletId: 'b', amount: 1 },
    ]
    expect(requestFingerprint(entries, { x: 1, y: 2 })).toBe(
      requestFingerprint(entries, { y: 2, x: 1 }),
    )
    expect(requestFingerprint([...entries].reverse(), null)).not.toBe(
      requestFingerprint(entries, null),
    )
  })
})

describe('assertAmount / addExact', () => {
  test('accepts signed integers inside the safe range', () => {
    for (const value of [0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      expect(() => assertAmount(value, 'amount')).not.toThrow()
    }
  })

  test('rejects everything else', () => {
    const bad: unknown[] = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      -0,
      '1',
      null,
      undefined,
      10n,
    ]
    for (const value of bad) {
      expect(() => assertAmount(value, 'amount')).toThrow(InvalidAmountError)
    }
  })

  test('addExact refuses to leave the safe range', () => {
    expect(addExact(1, 2, 'x')).toBe(3)
    expect(() => addExact(Number.MAX_SAFE_INTEGER, 1, 'x')).toThrow(InvalidAmountError)
    expect(() => addExact(Number.MIN_SAFE_INTEGER, -1, 'x')).toThrow(InvalidAmountError)
  })
})

describe('Mutex', () => {
  test('runs operations one at a time, in order', async () => {
    const mutex = new Mutex()
    const log: number[] = []
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        mutex.run(async () => {
          log.push(i)
          await new Promise((resolve) => setTimeout(resolve, 1))
          log.push(i)
        }),
      ),
    )
    // Each operation's two entries are adjacent — nothing interleaved.
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i]).toBe(log[i + 1]!)
    }
  })

  test('a rejection does not break the chain', async () => {
    const mutex = new Mutex()
    const failed = mutex.run(() => {
      throw new Error('boom')
    })
    await expect(failed).rejects.toThrow('boom')
    expect(await mutex.run(() => 'still works')).toBe('still works')
  })

  test('tracks pending work and drains', async () => {
    const mutex = new Mutex()
    const work = [mutex.run(() => 1), mutex.run(() => 2)]
    expect(mutex.pending).toBe(2)
    await Promise.all(work)
    await mutex.drain()
    expect(mutex.pending).toBe(0)
  })
})

describe('BalanceCache', () => {
  test('evicts the least recently used entry', () => {
    const cache = new BalanceCache(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // 'a' becomes the most recent
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
  })

  test('a size of zero stores nothing', () => {
    const cache = new BalanceCache(0)
    cache.set('a', 1)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('counts hits, misses and invalidations', () => {
    const cache = new BalanceCache(10)
    cache.set('a', 1)
    cache.get('a')
    cache.get('b')
    cache.clear()
    expect(cache.snapshot()).toEqual({ size: 0, hits: 1, misses: 1, invalidations: 1 })
  })

  test('clearing an empty cache is not counted as an invalidation', () => {
    const cache = new BalanceCache(10)
    cache.clear()
    expect(cache.snapshot().invalidations).toBe(0)
  })
})
