import { afterEach, describe, expect, test } from 'bun:test'
import {
  InvalidArgumentError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../src/index.js'
import { cleanup, openLedger } from './helpers.js'

afterEach(cleanup)

describe('createWallet', () => {
  test('creates a wallet with defaults', async () => {
    const book = await openLedger()
    const wallet = await book.createWallet('acme')
    expect(wallet).toMatchObject({
      id: 'acme',
      currency: 'BRL',
      allowNegative: false,
      balance: 0,
      movementCount: 0,
      headHash: null,
      metadata: null,
    })
    expect(wallet.createdAt).toBeGreaterThan(0)
  })

  test('accepts an options object', async () => {
    const book = await openLedger({ defaultCurrency: 'USD' })
    const wallet = await book.createWallet({
      id: 'revenue',
      currency: 'EUR',
      allowNegative: true,
      metadata: { team: 'finance' },
    })
    expect(wallet.currency).toBe('EUR')
    expect(wallet.allowNegative).toBe(true)
    expect(wallet.metadata).toEqual({ team: 'finance' })
  })

  test('uses defaultCurrency when none is given', async () => {
    const book = await openLedger({ defaultCurrency: 'USD' })
    expect((await book.createWallet('x')).currency).toBe('USD')
  })

  test('refuses to invent a currency', async () => {
    const book = await openLedger({ defaultCurrency: undefined })
    const error = await book.createWallet('nameless').catch((e: InvalidArgumentError) => e)
    expect(error).toBeInstanceOf(InvalidArgumentError)
    // The message has to say both ways out, because which one is right depends
    // on whether the book is single- or multi-currency.
    expect((error as Error).message).toContain('needs a currency')
    expect((error as Error).message).toContain('createWallet')
    expect((error as Error).message).toContain('defaultCurrency')
    expect((await book.stats()).wallets).toBe(0)
  })

  test('a wallet may name its own currency with no ledger default', async () => {
    const book = await openLedger({ defaultCurrency: undefined })
    expect((await book.createWallet({ id: 'a', currency: 'USD' })).currency).toBe('USD')
  })

  test('a multi-currency book needs no default at all', async () => {
    const book = await openLedger({ defaultCurrency: undefined })
    await book.createWallet({ id: 'brl', currency: 'BRL', allowNegative: true })
    await book.createWallet({ id: 'usd', currency: 'USD', allowNegative: true })
    await book.addMovement(
      [
        { walletId: 'brl', amount: -100 },
        { walletId: 'brl', amount: 100 },
      ],
      'k',
    )
    expect((await book.verify()).ok).toBe(true)
  })

  test('rejects an empty currency just as firmly as a missing one', async () => {
    const book = await openLedger({ defaultCurrency: undefined })
    await expect(book.createWallet({ id: 'a', currency: '' })).rejects.toThrow(InvalidArgumentError)
  })

  test('rejects duplicates', async () => {
    const book = await openLedger()
    await book.createWallet('dup')
    await expect(book.createWallet('dup')).rejects.toThrow(WalletAlreadyExistsError)
    expect((await book.stats()).wallets).toBe(1)
  })

  test('rejects invalid ids and metadata', async () => {
    const book = await openLedger()
    await expect(book.createWallet('')).rejects.toThrow(InvalidArgumentError)
    // @ts-expect-error runtime guard
    await expect(book.createWallet(42)).rejects.toThrow(InvalidArgumentError)
    await expect(
      // @ts-expect-error runtime guard
      book.createWallet({ id: 'meta', metadata: [1, 2] }),
    ).rejects.toThrow(InvalidArgumentError)
    await expect(book.createWallet({ id: 'meta', metadata: { bad: Number.NaN } })).rejects.toThrow(
      InvalidArgumentError,
    )
  })
})

describe('getWallet / listWallets / getBalance', () => {
  test('reads a wallet back', async () => {
    const book = await openLedger()
    await book.createWallet({ id: 'a', metadata: { z: 1, a: 2 } })
    const wallet = await book.getWallet('a')
    expect(wallet.metadata).toEqual({ a: 2, z: 1 })
  })

  test('lists wallets in creation order', async () => {
    const book = await openLedger()
    for (const id of ['c', 'a', 'b']) await book.createWallet(id)
    expect((await book.listWallets()).map((w) => w.id)).toEqual(['c', 'a', 'b'])
  })

  test('unknown wallets throw', async () => {
    const book = await openLedger()
    await expect(book.getWallet('nope')).rejects.toThrow(WalletNotFoundError)
    await expect(book.getBalance('nope')).rejects.toThrow(WalletNotFoundError)
    await expect(book.getBalances(['nope'])).rejects.toThrow(WalletNotFoundError)
    await expect(book.getBalance('')).rejects.toThrow(InvalidArgumentError)
  })

  test('new wallets start at zero', async () => {
    const book = await openLedger()
    await book.createWallet('a')
    expect(await book.getBalance('a')).toBe(0)
  })

  test('getBalances deduplicates ids', async () => {
    const book = await openLedger()
    await book.createWallet('a')
    await book.createWallet('b')
    expect(await book.getBalances(['a', 'b', 'a'])).toEqual({ a: 0, b: 0 })
  })
})
