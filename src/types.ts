import type { DriverName } from './driver/types.js'

/** Arbitrary JSON-serialisable context attached to a wallet or a movement. */
export type Metadata = Record<string, unknown>

/**
 * Produces a detached signature over the bytes it is handed.
 *
 * Deliberately an interface rather than a private key: the whole point of
 * signing checkpoints is that an auditor can verify them without holding
 * anything secret, which only pays off if the secret can live somewhere the
 * application cannot read — a KMS, an HSM, a separate signing service. Pass
 * `ed25519Signer` from `izi-ledger/signing` when a local key is enough.
 */
export interface Signer {
  keyId: string
  /** Only ed25519 is understood by the bundled verifier. Default: `'ed25519'`. */
  algorithm?: 'ed25519'
  sign(payload: Uint8Array): Uint8Array | Promise<Uint8Array>
}

export interface CheckpointSignature {
  algorithm: string
  keyId: string
  /** Base64. */
  value: string
}

/**
 * A compact commitment to the whole ledger at one point in its history.
 *
 * Published somewhere the ledger's operators do not control, it is what turns
 * "tamper-evident to us" into "tamper-evident to a third party": once this is
 * out there, no later rewrite of the book can be made consistent with it.
 */
export interface Checkpoint {
  version: string
  /** Identifies which ledger this describes, so a swapped file is detectable. */
  ledgerId: string
  /** Last movement covered. `0` for a checkpoint of an empty ledger. */
  seq: number
  headHash: string | null
  movementCount: number
  /** Sum of every movement per currency. Always 0 in a healthy ledger. */
  totals: Record<string, number>
  timestamp: number
  /** Hash of the previous checkpoint, so a missing one is visible. */
  previousCheckpoint: string | null
  hash: string
  signature: CheckpointSignature | null
}

export interface VerifyOptions {
  /** Check just this wallet's chain instead of the whole ledger. */
  walletId?: string
  /**
   * Previously published checkpoints. Each one must still be reproducible from
   * the ledger as it stands, which is what catches a consistent rewrite of the
   * entire history — the rewrite cannot reproduce an anchor it never saw.
   */
  anchors?: Checkpoint[]
  /** Public keys by key id. Anchors carrying a signature are verified against these. */
  publicKeys?: Record<string, string>
}

export interface LedgerOptions {
  /** Database file path. Defaults to `:memory:`. */
  path?: string
  /** Force a SQLite driver instead of auto-detecting. */
  driver?: DriverName
  /**
   * `'full'` fsyncs on every commit — no committed movement can be lost to a
   * power cut, at the cost of a disk sync per transaction. `'normal'` is
   * faster and still crash-safe against process death, but a machine-level
   * crash can lose the last commits. Default: `'full'`.
   */
  durability?: 'full' | 'normal'
  /**
   * Currency wallets inherit when `createWallet` does not name one.
   *
   * There is no built-in default: a wallet created without a currency here and
   * without one of its own is an error, not a guess. Single-currency books set
   * this once; multi-currency books leave it unset and name the currency on
   * every wallet, which is where it actually belongs.
   */
  defaultCurrency?: string
  /** Max wallets kept in the in-memory balance cache. `0` disables it. Default `10_000`. */
  cacheSize?: number
  /** Milliseconds to wait on a locked database before failing. Default `5000`. */
  busyTimeoutMs?: number
  /** Walk and re-hash the whole chain when opening. Default `false`. */
  verifyOnOpen?: boolean
  /** Clock injection point for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
  /** Signs checkpoints as they are produced. Omit to emit them unsigned. */
  signer?: Signer
}

export interface CreateWalletOptions {
  id: string
  /** Currency/asset code. Movements may only net to zero within one currency. */
  currency?: string
  /** Allow the balance to go below zero (system, revenue and clearing accounts). */
  allowNegative?: boolean
  metadata?: Metadata
}

export interface Wallet {
  id: string
  currency: string
  allowNegative: boolean
  balance: number
  /** Number of movements recorded against this wallet. */
  movementCount: number
  /** Hash of this wallet's most recent movement, or `null` when it has none. */
  headHash: string | null
  metadata: Metadata | null
  createdAt: number
}

export interface MovementInput {
  walletId: string
  /** Signed integer in the currency's minor unit (cents). */
  amount: number
  metadata?: Metadata
}

export interface AddMovementOptions {
  /**
   * Replay guard, required. Calling `addMovement` again with the same key and
   * the same entries returns the original transaction instead of writing a
   * second one. There is no way to record a transaction without one: an
   * unguarded write is a double-spend waiting for a retry.
   */
  idempotencyKey: string
  /** Metadata for the transaction as a whole. */
  metadata?: Metadata
}

export interface Movement {
  /** Global, gap-free position of this movement in the ledger. */
  seq: number
  /** Transaction this movement belongs to (all entries of one `addMovement`). */
  txId: string
  /** Idempotency key of that transaction. Stored once, on the transaction. */
  idempotencyKey: string
  walletId: string
  currency: string
  /** Signed integer in minor units. */
  amount: number
  /** Wallet balance immediately after this movement was applied. */
  balance: number
  /** Epoch milliseconds. Non-decreasing across the ledger. */
  timestamp: number
  /** SHA-256 over every field of this movement plus both previous hashes. */
  hash: string
  /** Hash of the previous movement in the whole ledger, `null` for the first. */
  prevHash: string | null
  /** Hash of the previous movement in this wallet, `null` for the wallet's first. */
  prevWalletHash: string | null
  /** Position of this movement within its wallet, starting at 1. */
  walletSeq: number
  metadata: Metadata | null
}

export interface TransactionResult {
  id: string
  idempotencyKey: string
  timestamp: number
  /** `true` when the call was deduplicated against an earlier identical one. */
  replayed: boolean
  metadata: Metadata | null
  movements: Movement[]
}

export interface ListMovementsOptions {
  walletId?: string
  txId?: string
  idempotencyKey?: string
  /** Only movements with `seq` greater than this. Use for cursor pagination. */
  afterSeq?: number
  limit?: number
  order?: 'asc' | 'desc'
}

export interface IntegrityIssue {
  seq: number | null
  walletId: string | null
  reason: string
  /**
   * Which check produced this. Lets a report say which part failed instead of
   * marking everything red because something did.
   */
  category: 'chain' | 'anchor' | 'signature'
}

export interface VerifyResult {
  ok: boolean
  /** Number of movements walked. */
  checked: number
  /** Number of anchors checked, when any were supplied. */
  anchorsChecked?: number
  issues: IntegrityIssue[]
}

export interface LedgerStats {
  driver: DriverName
  path: string
  wallets: number
  movements: number
  transactions: number
  headHash: string | null
  lastSeq: number
  cache: { size: number; hits: number; misses: number; invalidations: number }
}

export interface Ledger {
  createWallet(options: CreateWalletOptions | string): Promise<Wallet>
  getWallet(walletId: string): Promise<Wallet>
  listWallets(): Promise<Wallet[]>
  /** Current balance of `walletId`, in minor units. Served from cache when warm. */
  getBalance(walletId: string): Promise<number>
  /** Balances for several wallets in one round trip. */
  getBalances(walletIds: string[]): Promise<Record<string, number>>
  /** Record one zero-sum, double-entry transaction. */
  addMovement(
    entries: MovementInput[],
    options: AddMovementOptions | string,
  ): Promise<TransactionResult>
  getTransaction(idempotencyKeyOrTxId: string): Promise<TransactionResult | null>
  listMovements(options?: ListMovementsOptions): Promise<Movement[]>
  /** Re-hash and re-link the chain. Pass a wallet id, or options with anchors. */
  verify(walletIdOrOptions?: string | VerifyOptions): Promise<VerifyResult>
  /**
   * Commit to the ledger's current state. Store the result somewhere the
   * ledger's operators do not control, then feed it back through
   * `verify({ anchors })` or the `izi-ledger audit` command.
   */
  checkpoint(): Promise<Checkpoint>
  /** Checkpoints this ledger has produced, oldest first. */
  listCheckpoints(): Promise<Checkpoint[]>
  stats(): Promise<LedgerStats>
  close(): Promise<void>
  readonly closed: boolean
}
