import { createHash } from 'node:crypto'
import { InvalidArgumentError } from './errors.js'
import type { Metadata } from './types.js'

/**
 * Deterministic JSON: object keys sorted, no incidental whitespace. Two
 * structurally equal values always produce the same string, so the same
 * movement always produces the same hash regardless of insertion order.
 */
export function canonicalJson(value: unknown): string {
  return stringify(value, 0)
}

function stringify(value: unknown, depth: number): string {
  if (depth > 32) {
    throw new InvalidArgumentError('Metadata is nested deeper than 32 levels.')
  }
  if (value === null) return 'null'
  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new InvalidArgumentError(`Metadata cannot contain ${String(value)}.`)
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (type === 'bigint') return `"${(value as bigint).toString()}"`
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new InvalidArgumentError(`Metadata cannot contain a ${type} value.`)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringify(item, depth + 1)).join(',')}]`
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stringify(v, depth + 1)}`).join(',')}}`
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Bumping this invalidates every stored hash, so it is part of the schema contract. */
export const HASH_VERSION = 'izi-ledger/v1'

export interface HashInput {
  seq: number
  txId: string
  idempotencyKey: string
  walletId: string
  currency: string
  amount: number
  balance: number
  timestamp: number
  walletSeq: number
  prevHash: string | null
  prevWalletHash: string | null
  metadata: Metadata | null
}

/**
 * Every field that describes the movement goes into the digest, including both
 * previous hashes. Tampering with any single column — an amount, a timestamp,
 * a running balance — breaks this movement's hash and, through `prevHash`,
 * every movement after it.
 */
export function movementHash(input: HashInput): string {
  return sha256(
    canonicalJson([
      HASH_VERSION,
      input.seq,
      input.txId,
      input.idempotencyKey,
      input.walletId,
      input.currency,
      input.amount,
      input.balance,
      input.timestamp,
      input.walletSeq,
      input.prevHash,
      input.prevWalletHash,
      input.metadata,
    ]),
  )
}

/**
 * Fingerprint of an `addMovement` request, used to tell an honest retry apart
 * from an idempotency key accidentally reused for different entries.
 */
export function requestFingerprint(
  entries: ReadonlyArray<{ walletId: string; amount: number; metadata?: Metadata }>,
  metadata: Metadata | null,
): string {
  return sha256(
    canonicalJson([
      HASH_VERSION,
      entries.map((e) => [e.walletId, e.amount, e.metadata ?? null]),
      metadata,
    ]),
  )
}
