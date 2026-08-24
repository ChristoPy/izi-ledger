import { canonicalJson, sha256 } from './canonical.js'
import type { Checkpoint, CheckpointSignature } from './types.js'

/** Bumping this invalidates every stored checkpoint, so it is part of the contract. */
export const CHECKPOINT_VERSION = 'izi-ledger/checkpoint/v1'

/**
 * The bytes a checkpoint commits to.
 *
 * These are what gets hashed and what gets signed — not the digest — so a
 * verifier recomputes the payload from the checkpoint's own fields and never
 * has to trust the `hash` field it was handed.
 */
export function checkpointPayload(input: {
  ledgerId: string
  seq: number
  headHash: string | null
  movementCount: number
  totals: Record<string, number>
  timestamp: number
  previousCheckpoint: string | null
}): string {
  return canonicalJson([
    CHECKPOINT_VERSION,
    input.ledgerId,
    input.seq,
    input.headHash,
    input.movementCount,
    // canonicalJson sorts object keys, so currency order cannot change the digest.
    input.totals,
    input.timestamp,
    input.previousCheckpoint,
  ])
}

export function checkpointHash(payload: string): string {
  return sha256(payload)
}

/** The payload of an already-built checkpoint, for re-hashing and signature checks. */
export function payloadOf(checkpoint: Checkpoint): string {
  return checkpointPayload(checkpoint)
}

/**
 * Recompute a checkpoint's own digest and compare it with what it claims.
 * Catches a checkpoint whose fields were edited after it was written.
 */
export function checkpointHashMatches(checkpoint: Checkpoint): boolean {
  return checkpointHash(payloadOf(checkpoint)) === checkpoint.hash
}

export function serialiseSignature(signature: CheckpointSignature | null): string | null {
  return signature ? canonicalJson(signature) : null
}

export function parseSignature(value: unknown): CheckpointSignature | null {
  if (value === null || value === undefined) return null
  return JSON.parse(String(value)) as CheckpointSignature
}
