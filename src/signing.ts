import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto'
import { payloadOf } from './checkpoint.js'
import { InvalidArgumentError } from './errors.js'
import type { Checkpoint, Signer } from './types.js'

/**
 * A signer backed by a local Ed25519 key.
 *
 * Fine for a single service that owns its own book. If the threat you care
 * about includes whoever can read the application's filesystem or environment,
 * the key needs to live where they cannot reach it — implement `Signer` against
 * a KMS or HSM instead, and this module's verifier still works unchanged.
 */
export function ed25519Signer(options: {
  keyId: string
  /** PEM (PKCS#8), a raw 32-byte seed, or a KeyObject. */
  privateKey: string | Uint8Array | KeyObject
}): Signer {
  if (typeof options.keyId !== 'string' || options.keyId.length === 0) {
    throw new InvalidArgumentError('ed25519Signer requires a non-empty keyId.')
  }
  const key = toPrivateKey(options.privateKey)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new InvalidArgumentError(
      `ed25519Signer needs an Ed25519 key, got ${key.asymmetricKeyType ?? 'an unknown key type'}.`,
    )
  }
  return {
    keyId: options.keyId,
    algorithm: 'ed25519',
    // Ed25519 hashes internally, so the algorithm argument is null by design.
    sign: (payload) => new Uint8Array(nodeSign(null, payload, key)),
  }
}

/** Generate an Ed25519 keypair as PEM. The public half is what an auditor needs. */
export function generateSigningKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return { privateKey, publicKey }
}

export interface SignatureCheck {
  ok: boolean
  reason?: string
}

/**
 * Verify a checkpoint's signature against a set of public keys.
 *
 * The signature covers the checkpoint's canonical payload, not its `hash`
 * field, so a checkpoint whose fields were edited fails here even if `hash`
 * was edited to match.
 */
export function verifyCheckpointSignature(
  checkpoint: Checkpoint,
  publicKeys: Record<string, string | Uint8Array | KeyObject>,
): SignatureCheck {
  const { signature } = checkpoint
  if (!signature) return { ok: false, reason: 'checkpoint carries no signature' }
  if (signature.algorithm !== 'ed25519') {
    return { ok: false, reason: `unsupported signature algorithm "${signature.algorithm}"` }
  }

  const candidates =
    signature.keyId in publicKeys
      ? [[signature.keyId, publicKeys[signature.keyId]] as const]
      : Object.entries(publicKeys)
  if (candidates.length === 0) {
    return { ok: false, reason: `no public key supplied for key id "${signature.keyId}"` }
  }

  const payload = new TextEncoder().encode(payloadOf(checkpoint))
  let value: Buffer
  try {
    value = Buffer.from(signature.value, 'base64')
  } catch {
    return { ok: false, reason: 'signature is not valid base64' }
  }

  for (const [, candidate] of candidates) {
    if (candidate === undefined) continue
    try {
      if (nodeVerify(null, payload, toPublicKey(candidate), value)) return { ok: true }
    } catch {
      // Wrong key type or malformed key — try the next one.
    }
  }
  return {
    ok: false,
    reason: `signature does not verify against ${
      candidates.length === 1 ? `key "${candidates[0]?.[0]}"` : `any of ${candidates.length} keys`
    }`,
  }
}

function toPrivateKey(key: string | Uint8Array | KeyObject): KeyObject {
  if (typeof key === 'string') return createPrivateKey(key)
  if (!(key instanceof Uint8Array)) return key
  // A bare 32-byte seed: wrap it in the minimal PKCS#8 envelope Node expects.
  if (key.length === 32) {
    const der = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(key),
    ])
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  }
  return createPrivateKey({ key: Buffer.from(key), format: 'der', type: 'pkcs8' })
}

function toPublicKey(key: string | Uint8Array | KeyObject): KeyObject {
  if (typeof key === 'string') return createPublicKey(key)
  if (!(key instanceof Uint8Array)) return key
  if (key.length === 32) {
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)])
    return createPublicKey({ key: der, format: 'der', type: 'spki' })
  }
  return createPublicKey({ key: Buffer.from(key), format: 'der', type: 'spki' })
}
