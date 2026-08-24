import { afterEach, describe, expect, test } from 'bun:test'
import { requestFingerprint } from '../src/canonical.js'
import { CHECKPOINT_VERSION, checkpointHashMatches, movementHash } from '../src/index.js'
import { ed25519Signer, generateSigningKeyPair, verifyCheckpointSignature } from '../src/signing.js'
import type { Checkpoint } from '../src/types.js'
import { cleanup, openLedger, raw, tempDbPath } from './helpers.js'

afterEach(cleanup)

async function book(options: Parameters<typeof openLedger>[0] = {}) {
  const l = await openLedger({ path: tempDbPath(), ...options })
  await l.createWallet({ id: 'gw', allowNegative: true })
  await l.createWallet('fees')
  return l
}

const move = (n = 100) => [
  { walletId: 'gw', amount: -n },
  { walletId: 'fees', amount: n },
]

/**
 * Rewrite the whole history the way someone with the file *and* this library
 * would: change amounts, then recompute every balance, both hash chains, each
 * transaction fingerprint, the wallet rows and the ledger head. Plain
 * verification cannot tell the result from a genuine book — that is the entire
 * reason checkpoints exist.
 */
function rewriteHistory(path: string, edits: Record<number, number>) {
  raw(path, (db) => {
    for (const [seq, amount] of Object.entries(edits)) {
      db.run('UPDATE movements SET amount = ? WHERE seq = ?', [amount, Number(seq)])
    }
    const balances: Record<string, number> = {}
    const heads: Record<string, string | null> = {}
    let prev: string | null = null

    for (const m of db.query('SELECT * FROM movements ORDER BY seq').all() as Record<
      string,
      never
    >[]) {
      const row = m as unknown as {
        seq: number
        tx_id: string
        wallet_id: string
        currency: string
        amount: number
        timestamp: number
        wallet_seq: number
        metadata: string | null
      }
      balances[row.wallet_id] = (balances[row.wallet_id] ?? 0) + row.amount
      const key = (
        db.query('SELECT idempotency_key k FROM transactions WHERE id = ?').get(row.tx_id) as {
          k: string
        }
      ).k
      const hash = movementHash({
        seq: row.seq,
        txId: row.tx_id,
        idempotencyKey: key,
        walletId: row.wallet_id,
        currency: row.currency,
        amount: row.amount,
        balance: balances[row.wallet_id]!,
        timestamp: row.timestamp,
        walletSeq: row.wallet_seq,
        prevHash: prev,
        prevWalletHash: heads[row.wallet_id] ?? null,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      })
      db.run(
        'UPDATE movements SET balance = ?, hash = ?, prev_hash = ?, prev_wallet_hash = ? WHERE seq = ?',
        [balances[row.wallet_id]!, hash, prev, heads[row.wallet_id] ?? null, row.seq],
      )
      prev = hash
      heads[row.wallet_id] = hash
    }

    for (const t of db.query('SELECT * FROM transactions').all() as Record<string, never>[]) {
      const tx = t as unknown as { id: string; metadata: string | null }
      const entries = (
        db
          .query('SELECT wallet_id, amount, metadata FROM movements WHERE tx_id = ? ORDER BY seq')
          .all(tx.id) as Record<string, never>[]
      ).map((e) => {
        const entry = e as unknown as { wallet_id: string; amount: number; metadata: string | null }
        return {
          walletId: entry.wallet_id,
          amount: entry.amount,
          metadata: entry.metadata ? JSON.parse(entry.metadata) : undefined,
        }
      })
      db.run('UPDATE transactions SET request_hash = ? WHERE id = ?', [
        requestFingerprint(entries, tx.metadata ? JSON.parse(tx.metadata) : null),
        tx.id,
      ])
    }

    for (const [wallet, balance] of Object.entries(balances)) {
      db.run('UPDATE wallets SET balance = ?, head_hash = ? WHERE id = ?', [
        balance,
        heads[wallet]!,
        wallet,
      ])
    }
    db.run(`UPDATE meta SET value = ? WHERE key = 'head_hash'`, [prev])
  })
}

describe('checkpoint', () => {
  test('commits to the ledger as it stands', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    await l.addMovement(move(), 'p2')
    const cp = await l.checkpoint()

    expect(cp).toMatchObject({
      version: CHECKPOINT_VERSION,
      seq: 4,
      movementCount: 4,
      totals: { BRL: 0 },
      previousCheckpoint: null,
      signature: null,
    })
    expect(cp.ledgerId).toMatch(/^[0-9a-f-]{36}$/)
    expect(cp.headHash).toMatch(/^[0-9a-f]{64}$/)
    expect(checkpointHashMatches(cp)).toBe(true)
  })

  test('chains to the previous checkpoint', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    const first = await l.checkpoint()
    await l.addMovement(move(), 'p2')
    const second = await l.checkpoint()

    expect(first.previousCheckpoint).toBeNull()
    expect(second.previousCheckpoint).toBe(first.hash)
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  test('works on an empty ledger', async () => {
    const l = await openLedger()
    const cp = await l.checkpoint()
    expect(cp).toMatchObject({ seq: 0, movementCount: 0, headHash: null, totals: {} })
    expect((await l.verify({ anchors: [cp] })).ok).toBe(true)
  })

  test('is recorded locally and listable', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()
    const listed = await l.listCheckpoints()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(cp)
  })

  test('survives a reopen and keeps chaining', async () => {
    const path = tempDbPath()
    const first = await openLedger({ path })
    await first.createWallet({ id: 'gw', allowNegative: true })
    await first.createWallet('fees')
    await first.addMovement(move(), 'p1')
    const a = await first.checkpoint()
    await first.close()

    const second = await openLedger({ path })
    await second.addMovement(move(), 'p2')
    const b = await second.checkpoint()
    expect(b.previousCheckpoint).toBe(a.hash)
    expect(b.ledgerId).toBe(a.ledgerId)
  })
})

describe('signing', () => {
  test('signs checkpoints and verifies with the public half', async () => {
    const { privateKey, publicKey } = generateSigningKeyPair()
    const l = await book({ signer: ed25519Signer({ keyId: 'k1', privateKey }) })
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()

    expect(cp.signature).toMatchObject({ algorithm: 'ed25519', keyId: 'k1' })
    expect(verifyCheckpointSignature(cp, { k1: publicKey })).toEqual({ ok: true })
  })

  test('rejects a checkpoint signed by a different key', async () => {
    const { privateKey } = generateSigningKeyPair()
    const other = generateSigningKeyPair()
    const l = await book({ signer: ed25519Signer({ keyId: 'k1', privateKey }) })
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()
    expect(verifyCheckpointSignature(cp, { k1: other.publicKey }).ok).toBe(false)
  })

  test('rejects a checkpoint whose fields were edited after signing', async () => {
    const { privateKey, publicKey } = generateSigningKeyPair()
    const l = await book({ signer: ed25519Signer({ keyId: 'k1', privateKey }) })
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()

    // The signature covers the payload, not the hash field, so editing a value
    // and patching `hash` to match still fails.
    const forged: Checkpoint = { ...cp, totals: { BRL: 5_000 } }
    expect(verifyCheckpointSignature(forged, { k1: publicKey }).ok).toBe(false)
    expect(checkpointHashMatches(forged)).toBe(false)
  })

  test('an unsigned checkpoint does not pretend to be signed', async () => {
    const { publicKey } = generateSigningKeyPair()
    const l = await book()
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()
    expect(cp.signature).toBeNull()
    expect(verifyCheckpointSignature(cp, { k1: publicKey }).ok).toBe(false)
  })

  test('refuses a non-Ed25519 key', () => {
    expect(() => ed25519Signer({ keyId: 'k', privateKey: 'not a key' })).toThrow()
    expect(() =>
      ed25519Signer({ keyId: '', privateKey: generateSigningKeyPair().privateKey }),
    ).toThrow()
  })
})

describe('verify with anchors', () => {
  test('accepts anchors from a healthy ledger', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    const a = await l.checkpoint()
    await l.addMovement(move(), 'p2')
    const b = await l.checkpoint()

    const result = await l.verify({ anchors: [a, b] })
    expect(result).toEqual({ ok: true, checked: 4, anchorsChecked: 2, issues: [] })
  })

  test('an anchor stays valid as the ledger grows past it', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    const a = await l.checkpoint()
    for (let i = 0; i < 10; i++) await l.addMovement(move(), `later${i}`)
    expect((await l.verify({ anchors: [a] })).ok).toBe(true)
  })

  test('catches a full, internally consistent rewrite of history', async () => {
    const path = tempDbPath()
    const l = await openLedger({ path })
    await l.createWallet({ id: 'gw', allowNegative: true })
    await l.createWallet('fees')
    for (let i = 0; i < 4; i++) await l.addMovement(move(), `p${i}`)
    const anchor = await l.checkpoint()
    await l.close()

    rewriteHistory(path, { 3: -5_000, 4: 5_000 })

    const reopened = await openLedger({ path })
    // The rewrite is coherent: every hash, chain, fingerprint and balance agree.
    expect((await reopened.verify()).ok).toBe(true)
    expect(await reopened.getBalance('fees')).toBe(5_300)

    const anchored = await reopened.verify({ anchors: [anchor] })
    expect(anchored.ok).toBe(false)
    expect(anchored.anchorsChecked).toBe(1)
    expect(anchored.issues).toHaveLength(1)
    expect(anchored.issues[0]).toMatchObject({ category: 'anchor', seq: anchor.seq })
    expect(anchored.issues[0]!.reason).toContain('cannot be reproduced')
  })

  test('catches a truncated history', async () => {
    const path = tempDbPath()
    const l = await openLedger({ path })
    await l.createWallet({ id: 'gw', allowNegative: true })
    await l.createWallet('fees')
    for (let i = 0; i < 4; i++) await l.addMovement(move(), `p${i}`)
    const anchor = await l.checkpoint()
    await l.close()

    raw(path, (db) => {
      db.run('PRAGMA foreign_keys = OFF')
      db.run('DELETE FROM movements WHERE seq > 4')
      db.run(`UPDATE meta SET value = '4' WHERE key = 'last_seq'`)
    })

    const reopened = await openLedger({ path })
    const result = await reopened.verify({ anchors: [anchor] })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.reason.includes('truncated'))).toBe(true)
  })

  test('catches an anchor from a different ledger', async () => {
    const a = await book()
    await a.addMovement(move(), 'p1')
    const foreign = await a.checkpoint()

    const b = await book()
    await b.addMovement(move(), 'p1')
    const result = await b.verify({ anchors: [foreign] })
    expect(result.ok).toBe(false)
    expect(result.issues[0]!.reason).toMatch(/Wrong ledger|describes ledger/)
  })

  test('catches an anchor that was edited after publication', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()
    const forged: Checkpoint = { ...cp, totals: { BRL: 999 } }

    const result = await l.verify({ anchors: [forged] })
    expect(result.ok).toBe(false)
    expect(result.issues[0]!.reason).toContain('does not hash to the value it carries')
  })

  test('catches a removed checkpoint in the chain', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    await l.checkpoint()
    await l.addMovement(move(), 'p2')
    const second = await l.checkpoint()

    // The insider drops the local record of the first checkpoint; the auditor
    // still holds the second, which points at one this file denies exists.
    raw((await l.stats()).path, (db) => db.run('DELETE FROM checkpoints WHERE seq = 2'))
    const reopened = await openLedger({ path: (await l.stats()).path })
    const result = await reopened.verify({ anchors: [second] })
    expect(result.issues.some((i) => i.reason.includes('no record of'))).toBe(true)
  })

  test('verifies anchor signatures when public keys are supplied', async () => {
    const { privateKey, publicKey } = generateSigningKeyPair()
    const other = generateSigningKeyPair()
    const l = await book({ signer: ed25519Signer({ keyId: 'k1', privateKey }) })
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()

    expect((await l.verify({ anchors: [cp], publicKeys: { k1: publicKey } })).ok).toBe(true)

    const wrong = await l.verify({ anchors: [cp], publicKeys: { k1: other.publicKey } })
    expect(wrong.ok).toBe(false)
    expect(wrong.issues[0]).toMatchObject({ category: 'signature' })
  })

  test('supplying keys but no signature is itself a finding', async () => {
    const { publicKey } = generateSigningKeyPair()
    const l = await book()
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()
    const result = await l.verify({ anchors: [cp], publicKeys: { k1: publicKey } })
    expect(result.ok).toBe(false)
    expect(result.issues[0]!.reason).toContain('unsigned')
  })

  test('no public keys means signatures are not judged, not failed', async () => {
    const { privateKey } = generateSigningKeyPair()
    const l = await book({ signer: ed25519Signer({ keyId: 'k1', privateKey }) })
    await l.addMovement(move(), 'p1')
    const cp = await l.checkpoint()
    expect((await l.verify({ anchors: [cp] })).ok).toBe(true)
  })

  test('still accepts a plain wallet id', async () => {
    const l = await book()
    await l.addMovement(move(), 'p1')
    expect((await l.verify('fees')).ok).toBe(true)
    expect((await l.verify({ walletId: 'fees' })).ok).toBe(true)
  })
})
