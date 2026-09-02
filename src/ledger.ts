import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { addExact, assertAmount } from './amount.js'
import { BalanceCache } from './cache.js'
import { canonicalJson, movementHash, requestFingerprint } from './canonical.js'
import {
  CHECKPOINT_VERSION,
  checkpointHash,
  checkpointHashMatches,
  checkpointPayload,
  parseSignature,
  serialiseSignature,
} from './checkpoint.js'
import {
  type Driver,
  resolveDriver,
  type SqlParam,
  type SqlRow,
  type Statement,
} from './driver/index.js'
import {
  CurrencyMismatchError,
  IdempotencyConflictError,
  InsufficientFundsError,
  IntegrityError,
  InvalidArgumentError,
  LedgerClosedError,
  LedgerNotFoundError,
  LedgerUnreadableError,
  ReadOnlyLedgerError,
  UnbalancedMovementError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from './errors.js'
import { Mutex } from './mutex.js'
import { applyPragmas, applySchema, assertSchema } from './schema.js'
import { verifyCheckpointSignature } from './signing.js'
import type {
  AddMovementOptions,
  Checkpoint,
  CreateWalletOptions,
  IntegrityIssue,
  Ledger,
  LedgerOptions,
  LedgerStats,
  ListMovementsOptions,
  Metadata,
  Movement,
  MovementInput,
  Signer,
  TransactionResult,
  VerifyOptions,
  VerifyResult,
  Wallet,
} from './types.js'

const DEFAULTS = {
  path: ':memory:',
  durability: 'full' as const,
  cacheSize: 10_000,
  busyTimeoutMs: 5_000,
  verifyOnOpen: false,
  readonly: false,
}

const VERIFY_CHUNK = 1_000

/**
 * The idempotency key lives on `transactions` and nowhere else, so every read
 * of a movement rejoins it. Keeping one copy is what lets the movement hash
 * protect the key: rewriting it breaks the hash of every movement in that
 * transaction.
 */
const MOVEMENT_SELECT = `SELECT m.seq, m.tx_id, m.wallet_id, m.currency, m.amount, m.balance, m.timestamp,
          m.hash, m.prev_hash, m.prev_wallet_hash, m.wallet_seq, m.metadata,
          t.idempotency_key
     FROM movements m JOIN transactions t ON t.id = m.tx_id`

/**
 * Open a ledger.
 *
 * ```ts
 * const book = await ledger('./ledger.db')
 * await book.createWallet({ id: 'gateway', allowNegative: true })
 * await book.createWallet('user:1')
 * await book.addMovement(
 *   [
 *     { walletId: 'gateway', amount: -10_000 },
 *     { walletId: 'user:1', amount: 9_750 },
 *     { walletId: 'fees', amount: 250 },
 *   ],
 *   'payment:abc',
 * )
 * ```
 */
export async function ledger(options: LedgerOptions | string = {}): Promise<Ledger> {
  const opts = typeof options === 'string' ? { path: options } : options
  const path = opts.path ?? DEFAULTS.path
  const durability = opts.durability ?? DEFAULTS.durability
  const defaultCurrency = opts.defaultCurrency
  const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULTS.busyTimeoutMs
  const now = opts.now ?? (() => Date.now())

  const readonly = opts.readonly ?? DEFAULTS.readonly

  // Opening read-write creates the file, so a verifier pointed at a typo gets a
  // brand-new empty ledger — which passes every check there is. Read-only makes
  // SQLite refuse instead, and this check turns that refusal into an error that
  // names the real problem rather than a driver that "could not be loaded".
  if (readonly && path !== ':memory:' && !existsSync(path)) {
    throw new LedgerNotFoundError(path, 'the file does not exist')
  }

  let driver: Driver
  try {
    driver = await resolveDriver({ path, driver: opts.driver, readonly })
  } catch (error) {
    throw readonly && cannotOpen(error) ? new LedgerUnreadableError(path, { cause: error }) : error
  }
  try {
    applyPragmas(driver, { durability, busyTimeoutMs, readonly })
    if (readonly) assertSchema(driver, path)
    else applySchema(driver)
  } catch (error) {
    driver.close()
    // bun:sqlite opens lazily, so a file it cannot read surfaces here rather
    // than above. Same problem, same answer.
    throw readonly && cannotOpen(error) ? new LedgerUnreadableError(path, { cause: error }) : error
  }

  const instance = new LedgerImpl(driver, {
    path,
    defaultCurrency,
    cacheSize: opts.cacheSize ?? DEFAULTS.cacheSize,
    now,
    signer: opts.signer,
    readonly,
  })

  if (opts.verifyOnOpen ?? DEFAULTS.verifyOnOpen) {
    const result = await instance.verify()
    if (!result.ok) {
      await instance.close()
      throw new IntegrityError(
        `Ledger at "${path}" failed verification on open: ${result.issues
          .slice(0, 5)
          .map((i) => i.reason)
          .join('; ')}`,
      )
    }
  }

  return instance
}

interface InternalOptions {
  path: string
  defaultCurrency: string | undefined
  cacheSize: number
  now: () => number
  signer?: Signer
  readonly: boolean
}

interface WalletState {
  id: string
  currency: string
  allowNegative: boolean
  balance: number
  movementCount: number
  headHash: string | null
}

class LedgerImpl implements Ledger {
  private readonly driver: Driver
  private readonly options: InternalOptions
  private readonly mutex = new Mutex()
  private readonly cache: BalanceCache
  private readonly statements = new Map<string, Statement>()
  private isClosed = false
  /**
   * SQLite's `data_version` only changes when a *different* connection commits.
   * Watching it is what makes the balance cache safe to keep across calls even
   * if another process writes to the same file.
   */
  private dataVersion: number

  constructor(driver: Driver, options: InternalOptions) {
    this.driver = driver
    this.options = options
    this.cache = new BalanceCache(options.cacheSize)
    this.dataVersion = this.readDataVersion()
  }

  get closed(): boolean {
    return this.isClosed
  }

  // ---------------------------------------------------------------- internals

  private sql(query: string): Statement {
    let stmt = this.statements.get(query)
    if (!stmt) {
      stmt = this.driver.prepare(query)
      this.statements.set(query, stmt)
    }
    return stmt
  }

  private assertOpen(): void {
    if (this.isClosed) throw new LedgerClosedError()
  }

  private readDataVersion(): number {
    const row = this.sql('PRAGMA data_version').get()
    return row ? Number(row.data_version ?? 0) : 0
  }

  /** Drop the cache if another connection has committed since we last looked. */
  private syncDataVersion(): void {
    const current = this.readDataVersion()
    if (current !== this.dataVersion) {
      this.dataVersion = current
      this.cache.clear()
    }
  }

  private getMeta(key: string): string | null {
    const row = this.sql('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? ((row.value as string | null) ?? null) : null
  }

  private setMeta(key: string, value: string | null): void {
    this.sql(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  private nextTimestamp(): number {
    // Movements must be non-decreasing in time even if the wall clock jumps
    // backwards (NTP correction, DST-free but still adjustable clocks).
    const last = Number(this.getMeta('last_timestamp') ?? 0)
    return Math.max(Math.floor(this.options.now()), last)
  }

  private readWalletState(walletId: string): WalletState | undefined {
    const row = this.sql(
      'SELECT id, currency, allow_negative, balance, movement_count, head_hash FROM wallets WHERE id = ?',
    ).get(walletId)
    if (!row) return undefined
    return {
      id: row.id as string,
      currency: row.currency as string,
      allowNegative: Number(row.allow_negative) === 1,
      balance: Number(row.balance),
      movementCount: Number(row.movement_count),
      headHash: (row.head_hash as string | null) ?? null,
    }
  }

  private transaction<T>(fn: () => T): T {
    // Every write goes through here, so this is the only place that has to
    // know. SQLite would refuse anyway; saying so in the library's own
    // vocabulary beats surfacing a raw SQLITE_READONLY from three drivers.
    if (this.options.readonly) throw new ReadOnlyLedgerError(this.options.path)
    this.driver.exec('BEGIN IMMEDIATE;')
    let result: T
    try {
      result = fn()
    } catch (error) {
      try {
        this.driver.exec('ROLLBACK;')
      } catch {
        // Already rolled back (e.g. a constraint aborted the transaction).
      }
      throw error
    }
    this.driver.exec('COMMIT;')
    return result
  }

  // ------------------------------------------------------------------ wallets

  createWallet(input: CreateWalletOptions | string): Promise<Wallet> {
    return this.mutex.run(() => {
      this.assertOpen()
      const spec = typeof input === 'string' ? { id: input } : input
      const id = spec?.id
      if (typeof id !== 'string' || id.length === 0) {
        throw new InvalidArgumentError('createWallet requires a non-empty string id.')
      }
      // No currency is ever invented. A ledger that guesses one puts a label
      // on somebody's money that nobody chose, which is exactly the kind of
      // quiet mistake the rest of this library exists to prevent.
      const currency = spec.currency ?? this.options.defaultCurrency
      if (currency === undefined) {
        throw new InvalidArgumentError(
          `Wallet "${id}" needs a currency. Pass one on the wallet ` +
            `(createWallet({ id: "${id}", currency: "<code>" })), or set a ` +
            'defaultCurrency on the ledger for wallets to inherit.',
        )
      }
      if (typeof currency !== 'string' || currency.length === 0) {
        throw new InvalidArgumentError(`Wallet "${id}" has an invalid currency.`)
      }
      const metadata = normaliseMetadata(spec.metadata, `wallet "${id}"`)
      const createdAt = this.nextTimestamp()

      this.transaction(() => {
        if (this.readWalletState(id)) throw new WalletAlreadyExistsError(id)
        this.sql(
          `INSERT INTO wallets (id, currency, allow_negative, balance, movement_count, head_hash, metadata, created_at)
           VALUES (?, ?, ?, 0, 0, NULL, ?, ?)`,
        ).run(
          id,
          currency,
          spec.allowNegative ? 1 : 0,
          metadata ? canonicalJson(metadata) : null,
          createdAt,
        )
        this.setMeta('last_timestamp', String(createdAt))
      })

      this.cache.set(id, 0)
      return {
        id,
        currency,
        allowNegative: !!spec.allowNegative,
        balance: 0,
        movementCount: 0,
        headHash: null,
        metadata,
        createdAt,
      }
    })
  }

  getWallet(walletId: string): Promise<Wallet> {
    return this.mutex.run(() => {
      this.assertOpen()
      this.syncDataVersion()
      const row = this.sql('SELECT * FROM wallets WHERE id = ?').get(walletId)
      if (!row) throw new WalletNotFoundError(walletId)
      const wallet = rowToWallet(row)
      this.cache.set(wallet.id, wallet.balance)
      return wallet
    })
  }

  listWallets(): Promise<Wallet[]> {
    return this.mutex.run(() => {
      this.assertOpen()
      this.syncDataVersion()
      return this.sql('SELECT * FROM wallets ORDER BY rowid').all().map(rowToWallet)
    })
  }

  getBalance(walletId: string): Promise<number> {
    return this.mutex.run(() => {
      this.assertOpen()
      if (typeof walletId !== 'string' || walletId.length === 0) {
        throw new InvalidArgumentError('getBalance requires a non-empty wallet id.')
      }
      this.syncDataVersion()
      const cached = this.cache.get(walletId)
      if (cached !== undefined) return cached
      const state = this.readWalletState(walletId)
      if (!state) throw new WalletNotFoundError(walletId)
      this.cache.set(walletId, state.balance)
      return state.balance
    })
  }

  getBalances(walletIds: string[]): Promise<Record<string, number>> {
    return this.mutex.run(() => {
      this.assertOpen()
      if (!Array.isArray(walletIds)) {
        throw new InvalidArgumentError('getBalances requires an array of wallet ids.')
      }
      this.syncDataVersion()
      const out: Record<string, number> = {}
      for (const walletId of walletIds) {
        if (walletId in out) continue
        const cached = this.cache.get(walletId)
        if (cached !== undefined) {
          out[walletId] = cached
          continue
        }
        const state = this.readWalletState(walletId)
        if (!state) throw new WalletNotFoundError(walletId)
        this.cache.set(walletId, state.balance)
        out[walletId] = state.balance
      }
      return out
    })
  }

  // ---------------------------------------------------------------- movements

  addMovement(
    entries: MovementInput[],
    options: AddMovementOptions | string,
  ): Promise<TransactionResult> {
    return this.mutex.run(() => {
      this.assertOpen()
      const opts = typeof options === 'string' ? { idempotencyKey: options } : options
      const idempotencyKey = opts?.idempotencyKey
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        throw new InvalidArgumentError(
          'addMovement requires a non-empty idempotencyKey, either as the second argument ' +
            "or as options.idempotencyKey — e.g. addMovement(entries, 'payment:abc-123').",
        )
      }
      const normalised = normaliseEntries(entries)
      const txMetadata = normaliseMetadata(opts.metadata, 'transaction')
      const fingerprint = requestFingerprint(normalised, txMetadata)

      this.syncDataVersion()
      const replay = this.findTransaction(idempotencyKey, fingerprint)
      if (replay) return replay

      const touched = new Map<string, WalletState>()
      let result: TransactionResult
      try {
        result = this.transaction(() => {
          // Re-check inside the write lock: another process may have committed
          // the same idempotency key between our read and taking the lock.
          const raced = this.findTransaction(idempotencyKey, fingerprint)
          if (raced) return raced

          for (const entry of normalised) {
            if (touched.has(entry.walletId)) continue
            const state = this.readWalletState(entry.walletId)
            if (!state) throw new WalletNotFoundError(entry.walletId)
            touched.set(entry.walletId, state)
          }
          assertZeroSum(normalised, touched)

          const timestamp = this.nextTimestamp()
          const txId = randomUUID()
          let seq = Number(this.getMeta('last_seq') ?? 0)
          let prevHash = this.getMeta('head_hash')
          const seqStart = seq + 1

          this.sql(
            `INSERT INTO transactions (id, idempotency_key, request_hash, timestamp, seq_start, entry_count, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            txId,
            idempotencyKey,
            fingerprint,
            timestamp,
            seqStart,
            normalised.length,
            txMetadata ? canonicalJson(txMetadata) : null,
          )

          const movements: Movement[] = []
          const insertMovement = this.sql(
            `INSERT INTO movements
               (seq, tx_id, wallet_id, currency, amount, balance, timestamp,
                hash, prev_hash, prev_wallet_hash, wallet_seq, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )

          for (const entry of normalised) {
            const state = touched.get(entry.walletId)!
            const balance = addExact(state.balance, entry.amount, `Balance of wallet "${state.id}"`)
            if (balance < 0 && !state.allowNegative) {
              throw new InsufficientFundsError(state.id, state.balance, entry.amount)
            }
            seq += 1
            const walletSeq = state.movementCount + 1
            const metadata = entry.metadata ?? null
            const hash = movementHash({
              seq,
              txId,
              idempotencyKey,
              walletId: state.id,
              currency: state.currency,
              amount: entry.amount,
              balance,
              timestamp,
              walletSeq,
              prevHash,
              prevWalletHash: state.headHash,
              metadata,
            })

            insertMovement.run(
              seq,
              txId,
              state.id,
              state.currency,
              entry.amount,
              balance,
              timestamp,
              hash,
              prevHash,
              state.headHash,
              walletSeq,
              metadata ? canonicalJson(metadata) : null,
            )

            movements.push({
              seq,
              txId,
              idempotencyKey,
              walletId: state.id,
              currency: state.currency,
              amount: entry.amount,
              balance,
              timestamp,
              hash,
              prevHash,
              prevWalletHash: state.headHash,
              walletSeq,
              metadata,
            })

            prevHash = hash
            state.balance = balance
            state.movementCount = walletSeq
            state.headHash = hash
          }

          const updateWallet = this.sql(
            'UPDATE wallets SET balance = ?, movement_count = ?, head_hash = ? WHERE id = ?',
          )
          for (const state of touched.values()) {
            updateWallet.run(state.balance, state.movementCount, state.headHash, state.id)
          }

          this.setMeta('last_seq', String(seq))
          this.setMeta('head_hash', prevHash)
          this.setMeta('last_timestamp', String(timestamp))

          return {
            id: txId,
            idempotencyKey,
            timestamp,
            replayed: false,
            metadata: txMetadata,
            movements,
          } satisfies TransactionResult
        })
      } catch (error) {
        // The transaction rolled back, so any balance we computed for these
        // wallets describes a state that never existed. Drop them and let the
        // next read fall through to SQLite.
        for (const walletId of touched.keys()) this.cache.delete(walletId)
        throw error
      }

      if (result.replayed) return result

      // Only warm the cache once the commit has actually landed.
      for (const state of touched.values()) {
        this.cache.set(state.id, state.balance)
      }
      return result
    })
  }

  private findTransaction(idempotencyKey: string, fingerprint?: string): TransactionResult | null {
    const row = this.sql('SELECT * FROM transactions WHERE idempotency_key = ?').get(idempotencyKey)
    if (!row) return null
    if (fingerprint !== undefined && row.request_hash !== fingerprint) {
      throw new IdempotencyConflictError(idempotencyKey)
    }
    return this.buildTransactionResult(row, true)
  }

  private buildTransactionResult(row: SqlRow, replayed: boolean): TransactionResult {
    const movements = this.sql(`${MOVEMENT_SELECT} WHERE m.tx_id = ? ORDER BY m.seq`).all(
      row.id as string,
    )
    return {
      id: row.id as string,
      idempotencyKey: row.idempotency_key as string,
      timestamp: Number(row.timestamp),
      replayed,
      metadata: parseMetadata(row.metadata),
      movements: movements.map(rowToMovement),
    }
  }

  getTransaction(idempotencyKeyOrTxId: string): Promise<TransactionResult | null> {
    return this.mutex.run(() => {
      this.assertOpen()
      this.syncDataVersion()
      const row =
        this.sql('SELECT * FROM transactions WHERE idempotency_key = ?').get(
          idempotencyKeyOrTxId,
        ) ?? this.sql('SELECT * FROM transactions WHERE id = ?').get(idempotencyKeyOrTxId)
      return row ? this.buildTransactionResult(row, false) : null
    })
  }

  listMovements(options: ListMovementsOptions = {}): Promise<Movement[]> {
    return this.mutex.run(() => {
      this.assertOpen()
      this.syncDataVersion()
      const where: string[] = []
      const params: SqlParam[] = []
      if (options.walletId !== undefined) {
        where.push('m.wallet_id = ?')
        params.push(options.walletId)
      }
      if (options.txId !== undefined) {
        where.push('m.tx_id = ?')
        params.push(options.txId)
      }
      if (options.idempotencyKey !== undefined) {
        where.push('t.idempotency_key = ?')
        params.push(options.idempotencyKey)
      }
      if (options.afterSeq !== undefined) {
        where.push('m.seq > ?')
        params.push(options.afterSeq)
      }
      const limit = options.limit === undefined ? -1 : assertPositiveInt(options.limit, 'limit')
      const order = options.order === 'desc' ? 'DESC' : 'ASC'
      const sql =
        `${MOVEMENT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
        ` ORDER BY m.seq ${order} LIMIT ?`
      params.push(limit)
      return this.sql(sql)
        .all(...params)
        .map(rowToMovement)
    })
  }

  // ------------------------------------------------------------------- verify

  verify(walletIdOrOptions?: string | VerifyOptions): Promise<VerifyResult> {
    return this.mutex.run(() => {
      this.assertOpen()
      this.syncDataVersion()
      const options: VerifyOptions =
        typeof walletIdOrOptions === 'string'
          ? { walletId: walletIdOrOptions }
          : (walletIdOrOptions ?? {})

      const result =
        options.walletId === undefined ? this.verifyLedger() : this.verifyWallet(options.walletId)

      if (!options.anchors?.length) return result

      const anchorIssues = this.verifyAnchors(options.anchors, options.publicKeys ?? {})
      return {
        ok: result.issues.length === 0 && anchorIssues.length === 0,
        checked: result.checked,
        anchorsChecked: options.anchors.length,
        issues: [...result.issues, ...anchorIssues],
      }
    })
  }

  /**
   * Check the ledger against checkpoints that were published elsewhere.
   *
   * This is the part the hash chain alone cannot do. Anyone who can write to
   * the file and run this library can rewrite every movement and recompute
   * every hash, and plain verification will pass. What they cannot do is make
   * that rewrite reproduce a commitment that left the building before they
   * started.
   */
  private verifyAnchors(
    anchors: Checkpoint[],
    publicKeys: Record<string, string>,
  ): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []
    const ledgerId = this.getMeta('ledger_id')
    const lastSeq = Number(this.getMeta('last_seq') ?? 0)
    const known = new Set(
      this.sql('SELECT hash FROM checkpoints')
        .all()
        .map((row) => row.hash as string),
    )

    for (const anchor of [...anchors].sort((a, b) => a.seq - b.seq)) {
      const at = `checkpoint at seq ${anchor.seq}`

      if (anchor.version !== CHECKPOINT_VERSION) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} has unknown version "${anchor.version}".`,
          category: 'anchor',
        })
        continue
      }
      if (!checkpointHashMatches(anchor)) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} does not hash to the value it carries; it was altered after it was made.`,
          category: 'anchor',
        })
        continue
      }
      if (anchor.ledgerId !== ledgerId) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} describes ledger ${anchor.ledgerId}, this file is ${ledgerId}. Wrong ledger, or the file was swapped.`,
          category: 'anchor',
        })
        continue
      }
      if (anchor.seq > lastSeq) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} covers ${anchor.movementCount} movements but the ledger only has ${lastSeq}. History was truncated.`,
          category: 'anchor',
        })
        continue
      }

      const rebuilt = this.rebuildCheckpointAt(anchor)
      if (rebuilt === null) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} points at a movement that no longer exists.`,
          category: 'anchor',
        })
        continue
      }
      if (rebuilt !== anchor.hash) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} cannot be reproduced from this ledger: the history up to seq ${anchor.seq} is not the history that was committed to.`,
          category: 'anchor',
        })
        continue
      }

      // A link into a checkpoint this file has never heard of means one was
      // dropped. A link the auditor simply did not keep a copy of is fine.
      if (anchor.previousCheckpoint !== null && !known.has(anchor.previousCheckpoint)) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} follows a checkpoint this ledger has no record of. One was removed.`,
          category: 'anchor',
        })
      }

      // Signatures are only checked when keys were supplied. Passing no keys
      // means "I am not auditing authorship", not "every signature is bad".
      if (anchor.signature && Object.keys(publicKeys).length > 0) {
        const check = verifyCheckpointSignature(anchor, publicKeys)
        if (!check.ok) {
          issues.push({
            seq: anchor.seq,
            walletId: null,
            reason: `${at} signature check failed: ${check.reason}.`,
            category: 'signature',
          })
        }
      } else if (!anchor.signature && Object.keys(publicKeys).length > 0) {
        issues.push({
          seq: anchor.seq,
          walletId: null,
          reason: `${at} is unsigned, but public keys were supplied for verification.`,
          category: 'anchor',
        })
      }
    }

    return issues
  }

  /** Recompute what a checkpoint at this anchor's position should hash to. */
  private rebuildCheckpointAt(anchor: Checkpoint): string | null {
    if (anchor.seq === 0) {
      return checkpointHash(
        checkpointPayload({
          ledgerId: this.getMeta('ledger_id') ?? '',
          seq: 0,
          headHash: null,
          movementCount: 0,
          totals: {},
          timestamp: anchor.timestamp,
          previousCheckpoint: anchor.previousCheckpoint,
        }),
      )
    }
    const row = this.sql('SELECT hash FROM movements WHERE seq = ?').get(anchor.seq)
    if (!row) return null
    return checkpointHash(
      checkpointPayload({
        ledgerId: this.getMeta('ledger_id') ?? '',
        seq: anchor.seq,
        headHash: row.hash as string,
        movementCount: anchor.seq,
        totals: this.totalsUpTo(anchor.seq),
        // The timestamp is the anchor's own; it is covered by the signature and
        // is not something the ledger can re-derive.
        timestamp: anchor.timestamp,
        previousCheckpoint: anchor.previousCheckpoint,
      }),
    )
  }

  private totalsUpTo(seq: number): Record<string, number> {
    const totals: Record<string, number> = {}
    for (const row of this.sql(
      'SELECT currency, SUM(amount) AS total FROM movements WHERE seq <= ? GROUP BY currency',
    ).all(seq)) {
      totals[row.currency as string] = Number(row.total)
    }
    return totals
  }

  // -------------------------------------------------------------- checkpoints

  checkpoint(): Promise<Checkpoint> {
    return this.mutex.run(async () => {
      this.assertOpen()
      this.syncDataVersion()

      const ledgerId = this.getMeta('ledger_id') ?? ''
      const seq = Number(this.getMeta('last_seq') ?? 0)
      const headHash = this.getMeta('head_hash')
      const previousCheckpoint = this.getMeta('checkpoint_head')
      const timestamp = this.nextTimestamp()
      const totals = this.totalsUpTo(seq)

      const payload = checkpointPayload({
        ledgerId,
        seq,
        headHash,
        movementCount: seq,
        totals,
        timestamp,
        previousCheckpoint,
      })
      const hash = checkpointHash(payload)

      // Signing may reach a KMS, so it happens before the write transaction
      // rather than inside it. The mutex keeps the ledger still meanwhile.
      let signature: Checkpoint['signature'] = null
      const signer = this.options.signer
      if (signer) {
        const value = await signer.sign(new TextEncoder().encode(payload))
        signature = {
          algorithm: signer.algorithm ?? 'ed25519',
          keyId: signer.keyId,
          value: Buffer.from(value).toString('base64'),
        }
      }

      const checkpoint: Checkpoint = {
        version: CHECKPOINT_VERSION,
        ledgerId,
        seq,
        headHash,
        movementCount: seq,
        totals,
        timestamp,
        previousCheckpoint,
        hash,
        signature,
      }

      this.transaction(() => {
        this.sql(
          `INSERT INTO checkpoints
             (seq, ledger_id, head_hash, movement_count, totals, timestamp, previous_checkpoint, hash, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(seq) DO UPDATE SET
             head_hash = excluded.head_hash, movement_count = excluded.movement_count,
             totals = excluded.totals, timestamp = excluded.timestamp,
             previous_checkpoint = excluded.previous_checkpoint,
             hash = excluded.hash, signature = excluded.signature`,
        ).run(
          seq,
          ledgerId,
          headHash,
          seq,
          canonicalJson(totals),
          timestamp,
          previousCheckpoint,
          hash,
          serialiseSignature(signature),
        )
        this.setMeta('checkpoint_head', hash)
        this.setMeta('last_timestamp', String(timestamp))
      })

      return checkpoint
    })
  }

  listCheckpoints(): Promise<Checkpoint[]> {
    return this.mutex.run(() => {
      this.assertOpen()
      this.syncDataVersion()
      return this.sql('SELECT * FROM checkpoints ORDER BY seq').all().map(rowToCheckpoint)
    })
  }

  private verifyLedger(): VerifyResult {
    const issues: IntegrityIssue[] = []
    const walletRuntime = new Map<
      string,
      { balance: number; count: number; head: string | null; currency: string }
    >()
    const currencyTotals = new Map<string, number>()
    let prevHash: string | null = null
    let expectedSeq = 0
    let checked = 0
    let cursor = 0

    for (;;) {
      const rows = this.sql(`${MOVEMENT_SELECT} WHERE m.seq > ? ORDER BY m.seq LIMIT ?`).all(
        cursor,
        VERIFY_CHUNK,
      )
      if (rows.length === 0) break
      for (const row of rows) {
        const m = rowToMovement(row)
        cursor = m.seq
        checked++
        expectedSeq++
        if (m.seq !== expectedSeq) {
          issues.push({
            seq: m.seq,
            walletId: m.walletId,
            reason: `Gap in the global sequence: expected seq ${expectedSeq}, found ${m.seq}.`,
            category: 'chain',
          })
          expectedSeq = m.seq
        }
        if (m.prevHash !== prevHash) {
          issues.push({
            seq: m.seq,
            walletId: m.walletId,
            reason: `Broken global chain at seq ${m.seq}: prevHash ${describeHash(m.prevHash)} does not match the previous movement's hash ${describeHash(prevHash)}.`,
            category: 'chain',
          })
        }

        let state = walletRuntime.get(m.walletId)
        if (!state) {
          state = { balance: 0, count: 0, head: null, currency: m.currency }
          walletRuntime.set(m.walletId, state)
        }
        if (state.currency !== m.currency) {
          issues.push({
            seq: m.seq,
            walletId: m.walletId,
            reason: `Wallet "${m.walletId}" changed currency mid-chain: ${state.currency} -> ${m.currency}.`,
            category: 'chain',
          })
        }
        if (m.prevWalletHash !== state.head) {
          issues.push({
            seq: m.seq,
            walletId: m.walletId,
            reason: `Broken wallet chain for "${m.walletId}" at seq ${m.seq}: prevWalletHash ${describeHash(m.prevWalletHash)} does not match ${describeHash(state.head)}.`,
            category: 'chain',
          })
        }
        const expectedWalletSeq = state.count + 1
        if (m.walletSeq !== expectedWalletSeq) {
          issues.push({
            seq: m.seq,
            walletId: m.walletId,
            reason: `Wallet "${m.walletId}" position mismatch at seq ${m.seq}: expected walletSeq ${expectedWalletSeq}, found ${m.walletSeq}.`,
            category: 'chain',
          })
        }
        const expectedBalance = state.balance + m.amount
        if (m.balance !== expectedBalance) {
          issues.push({
            seq: m.seq,
            walletId: m.walletId,
            reason: `Running balance mismatch for "${m.walletId}" at seq ${m.seq}: stored ${m.balance}, recomputed ${expectedBalance}.`,
            category: 'chain',
          })
        }

        const recomputed = movementHash(m)
        if (recomputed !== m.hash) {
          issues.push({
            seq: m.seq,
            walletId: m.walletId,
            reason: `Hash mismatch at seq ${m.seq}: stored ${describeHash(m.hash)}, recomputed ${describeHash(recomputed)}.`,
            category: 'chain',
          })
        }

        state.balance = m.balance
        state.count = m.walletSeq
        state.head = m.hash
        prevHash = m.hash
        currencyTotals.set(m.currency, (currencyTotals.get(m.currency) ?? 0) + m.amount)
      }
      if (rows.length < VERIFY_CHUNK) break
    }

    for (const [currency, total] of currencyTotals) {
      if (total !== 0) {
        issues.push({
          seq: null,
          walletId: null,
          reason: `Ledger is not zero-sum for currency "${currency}": total ${total}.`,
          category: 'chain',
        })
      }
    }

    for (const row of this.sql('SELECT * FROM wallets').all()) {
      const wallet = rowToWallet(row)
      const state = walletRuntime.get(wallet.id) ?? {
        balance: 0,
        count: 0,
        head: null,
        currency: wallet.currency,
      }
      if (wallet.balance !== state.balance) {
        issues.push({
          seq: null,
          walletId: wallet.id,
          reason: `Stored balance for "${wallet.id}" is ${wallet.balance}, movements add up to ${state.balance}.`,
          category: 'chain',
        })
      }
      if (wallet.movementCount !== state.count) {
        issues.push({
          seq: null,
          walletId: wallet.id,
          reason: `Stored movement count for "${wallet.id}" is ${wallet.movementCount}, found ${state.count} movements.`,
          category: 'chain',
        })
      }
      if (wallet.headHash !== state.head) {
        issues.push({
          seq: null,
          walletId: wallet.id,
          reason: `Stored head hash for "${wallet.id}" does not match its last movement.`,
          category: 'chain',
        })
      }
    }

    issues.push(...this.verifyTransactions())

    const metaHead = this.getMeta('head_hash')
    if (metaHead !== prevHash) {
      issues.push({
        seq: null,
        walletId: null,
        reason: `Ledger head hash ${describeHash(metaHead)} does not match the last movement ${describeHash(prevHash)}.`,
        category: 'chain',
      })
    }
    const metaSeq = Number(this.getMeta('last_seq') ?? 0)
    if (metaSeq !== expectedSeq) {
      issues.push({
        seq: null,
        walletId: null,
        reason: `Ledger last_seq is ${metaSeq}, last movement is at seq ${expectedSeq}.`,
        category: 'chain',
      })
    }

    return { ok: issues.length === 0, checked, issues }
  }

  /**
   * Each transaction stores a fingerprint of the request that produced it.
   * Re-deriving it from the movements catches tampering with transaction-level
   * metadata, which no single movement hash covers.
   */
  private verifyTransactions(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = []
    for (const row of this.sql('SELECT * FROM transactions ORDER BY seq_start').all()) {
      const txId = row.id as string
      const movements = this.sql(`${MOVEMENT_SELECT} WHERE m.tx_id = ? ORDER BY m.seq`)
        .all(txId)
        .map(rowToMovement)
      if (movements.length !== Number(row.entry_count)) {
        issues.push({
          seq: Number(row.seq_start),
          walletId: null,
          reason: `Transaction ${txId} claims ${Number(row.entry_count)} entries but has ${movements.length}.`,
          category: 'chain',
        })
        continue
      }
      const fingerprint = requestFingerprint(
        movements.map((m) => ({
          walletId: m.walletId,
          amount: m.amount,
          metadata: m.metadata ?? undefined,
        })),
        parseMetadata(row.metadata),
      )
      if (fingerprint !== row.request_hash) {
        issues.push({
          seq: Number(row.seq_start),
          walletId: null,
          reason: `Transaction ${txId} no longer matches its request fingerprint.`,
          category: 'chain',
        })
      }
    }
    return issues
  }

  private verifyWallet(walletId: string): VerifyResult {
    const wallet = this.readWalletState(walletId)
    if (!wallet) throw new WalletNotFoundError(walletId)

    const issues: IntegrityIssue[] = []
    let balance = 0
    let head: string | null = null
    let walletSeq = 0
    let checked = 0
    let cursor = 0

    for (;;) {
      const rows = this.sql(
        `${MOVEMENT_SELECT} WHERE m.wallet_id = ? AND m.seq > ? ORDER BY m.seq LIMIT ?`,
      ).all(walletId, cursor, VERIFY_CHUNK)
      if (rows.length === 0) break
      for (const row of rows) {
        const m = rowToMovement(row)
        cursor = m.seq
        checked++
        walletSeq++
        if (m.walletSeq !== walletSeq) {
          issues.push({
            seq: m.seq,
            walletId,
            reason: `Wallet "${walletId}" position mismatch at seq ${m.seq}: expected walletSeq ${walletSeq}, found ${m.walletSeq}.`,
            category: 'chain',
          })
          walletSeq = m.walletSeq
        }
        if (m.prevWalletHash !== head) {
          issues.push({
            seq: m.seq,
            walletId,
            reason: `Broken wallet chain for "${walletId}" at seq ${m.seq}: prevWalletHash ${describeHash(m.prevWalletHash)} does not match ${describeHash(head)}.`,
            category: 'chain',
          })
        }
        const expected = balance + m.amount
        if (m.balance !== expected) {
          issues.push({
            seq: m.seq,
            walletId,
            reason: `Running balance mismatch for "${walletId}" at seq ${m.seq}: stored ${m.balance}, recomputed ${expected}.`,
            category: 'chain',
          })
        }
        const recomputed = movementHash(m)
        if (recomputed !== m.hash) {
          issues.push({
            seq: m.seq,
            walletId,
            reason: `Hash mismatch at seq ${m.seq}: stored ${describeHash(m.hash)}, recomputed ${describeHash(recomputed)}.`,
            category: 'chain',
          })
        }
        balance = m.balance
        head = m.hash
      }
      if (rows.length < VERIFY_CHUNK) break
    }

    if (wallet.balance !== balance) {
      issues.push({
        seq: null,
        walletId,
        reason: `Stored balance for "${walletId}" is ${wallet.balance}, movements add up to ${balance}.`,
        category: 'chain',
      })
    }
    if (wallet.headHash !== head) {
      issues.push({
        seq: null,
        walletId,
        reason: `Stored head hash for "${walletId}" does not match its last movement.`,
        category: 'chain',
      })
    }
    if (wallet.movementCount !== checked) {
      issues.push({
        seq: null,
        walletId,
        reason: `Stored movement count for "${walletId}" is ${wallet.movementCount}, found ${checked}.`,
        category: 'chain',
      })
    }

    return { ok: issues.length === 0, checked, issues }
  }

  // -------------------------------------------------------------------- misc

  stats(): Promise<LedgerStats> {
    return this.mutex.run(() => {
      this.assertOpen()
      this.syncDataVersion()
      const count = (table: string): number =>
        Number(this.sql(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
      return {
        driver: this.driver.name,
        path: this.options.path,
        wallets: count('wallets'),
        movements: count('movements'),
        transactions: count('transactions'),
        headHash: this.getMeta('head_hash'),
        lastSeq: Number(this.getMeta('last_seq') ?? 0),
        cache: this.cache.snapshot(),
      }
    })
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    // Take the lock so an in-flight transaction finishes before the handle goes.
    await this.mutex.run(() => {
      if (this.isClosed) return
      this.isClosed = true
      this.statements.clear()
      this.cache.clear()
      this.driver.close()
    })
  }
}

// ------------------------------------------------------------------ helpers

/**
 * SQLite's "unable to open database file", wherever in the stack it surfaced.
 *
 * The three drivers disagree on how they report it and `resolveDriver` wraps
 * whatever it caught, so this walks the cause chain and accepts either the
 * code or SQLite's own wording.
 */
function cannotOpen(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === 'SQLITE_CANTOPEN') return true
    if (current instanceof Error && current.message.includes('unable to open database file')) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function normaliseEntries(entries: MovementInput[]): MovementInput[] {
  if (!Array.isArray(entries)) {
    throw new InvalidArgumentError('addMovement expects an array of { walletId, amount } entries.')
  }
  if (entries.length === 0) {
    throw new InvalidArgumentError('addMovement expects at least one entry.')
  }
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new InvalidArgumentError(`Entry ${index} must be an object, got ${typeof entry}.`)
    }
    const { walletId, amount } = entry
    if (typeof walletId !== 'string' || walletId.length === 0) {
      throw new InvalidArgumentError(`Entry ${index} needs a non-empty string walletId.`)
    }
    assertAmount(amount, `Entry ${index} ("${walletId}") amount`)
    return {
      walletId,
      amount,
      metadata: normaliseMetadata(entry.metadata, `entry ${index} ("${walletId}")`) ?? undefined,
    }
  })
}

/**
 * Double entry: a transaction may touch several currencies, but the entries of
 * each currency must net to zero on their own. Cross-currency moves therefore
 * have to go through an explicit FX/clearing wallet, which is the point.
 */
function assertZeroSum(entries: MovementInput[], wallets: Map<string, WalletState>): void {
  const totals = new Map<string, number>()
  for (const entry of entries) {
    const wallet = wallets.get(entry.walletId)
    if (!wallet) throw new WalletNotFoundError(entry.walletId)
    const next = addExact(totals.get(wallet.currency) ?? 0, entry.amount, 'Movement total')
    totals.set(wallet.currency, next)
  }
  if (totals.size === 0) {
    throw new CurrencyMismatchError('Movement has no entries to balance.')
  }
  for (const [currency, total] of totals) {
    if (total !== 0) throw new UnbalancedMovementError(currency, total)
  }
}

function normaliseMetadata(value: unknown, label: string): Metadata | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidArgumentError(`Metadata for ${label} must be a plain object.`)
  }
  // Round-trip through the canonical form now, so a value that cannot be
  // hashed deterministically fails at the call site instead of at verify time.
  return JSON.parse(canonicalJson(value)) as Metadata
}

function parseMetadata(value: unknown): Metadata | null {
  if (value === null || value === undefined) return null
  return JSON.parse(String(value)) as Metadata
}

function rowToWallet(row: SqlRow): Wallet {
  return {
    id: row.id as string,
    currency: row.currency as string,
    allowNegative: Number(row.allow_negative) === 1,
    balance: Number(row.balance),
    movementCount: Number(row.movement_count),
    headHash: (row.head_hash as string | null) ?? null,
    metadata: parseMetadata(row.metadata),
    createdAt: Number(row.created_at),
  }
}

function rowToMovement(row: SqlRow): Movement {
  return {
    seq: Number(row.seq),
    txId: row.tx_id as string,
    idempotencyKey: row.idempotency_key as string,
    walletId: row.wallet_id as string,
    currency: row.currency as string,
    amount: Number(row.amount),
    balance: Number(row.balance),
    timestamp: Number(row.timestamp),
    hash: row.hash as string,
    prevHash: (row.prev_hash as string | null) ?? null,
    prevWalletHash: (row.prev_wallet_hash as string | null) ?? null,
    walletSeq: Number(row.wallet_seq),
    metadata: parseMetadata(row.metadata),
  }
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${label} must be a non-negative integer.`)
  }
  return value
}

function describeHash(hash: string | null): string {
  return hash === null ? '<none>' : `${hash.slice(0, 12)}…`
}

function rowToCheckpoint(row: SqlRow): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    ledgerId: row.ledger_id as string,
    seq: Number(row.seq),
    headHash: (row.head_hash as string | null) ?? null,
    movementCount: Number(row.movement_count),
    totals: JSON.parse(String(row.totals)) as Record<string, number>,
    timestamp: Number(row.timestamp),
    previousCheckpoint: (row.previous_checkpoint as string | null) ?? null,
    hash: row.hash as string,
    signature: parseSignature(row.signature),
  }
}
