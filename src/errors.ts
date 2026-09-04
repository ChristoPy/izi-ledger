export type LedgerErrorCode =
  | 'DRIVER_UNAVAILABLE'
  | 'LEDGER_CLOSED'
  | 'LEDGER_NOT_FOUND'
  | 'LEDGER_UNREADABLE'
  | 'READ_ONLY'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'INVALID_ARGUMENT'
  | 'INVALID_AMOUNT'
  | 'UNBALANCED_MOVEMENT'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTEGRITY_ERROR'
  | 'SCHEMA_VERSION_MISMATCH'

export class LedgerError extends Error {
  readonly code: LedgerErrorCode

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

export class DriverUnavailableError extends LedgerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('DRIVER_UNAVAILABLE', message, options)
  }
}

export class LedgerClosedError extends LedgerError {
  constructor(message = 'This ledger has been closed.') {
    super('LEDGER_CLOSED', message)
  }
}

/**
 * There is no ledger to read at the given path.
 *
 * Only reachable when opening read-only, which is the point: a verifier that
 * creates what it cannot find reports on a book it just invented.
 */
export class LedgerNotFoundError extends LedgerError {
  readonly path: string
  constructor(path: string, detail: string, options?: { cause?: unknown }) {
    super('LEDGER_NOT_FOUND', `No izi-ledger database at "${path}": ${detail}.`, options)
    this.path = path
  }
}

/**
 * The file is there and cannot be read without write access.
 *
 * Almost always a WAL-mode ledger that was archived on its own: SQLite needs
 * the `-shm` index to read through a WAL, and a read-only handle cannot create
 * one. Refusing is the only safe answer — the main file alone can be missing
 * every movement still sitting in the `-wal`, and reporting on that truncated
 * history is the failure this whole path exists to prevent.
 */
export class LedgerUnreadableError extends LedgerError {
  readonly path: string
  constructor(path: string, options?: { cause?: unknown }) {
    super(
      'LEDGER_UNREADABLE',
      `Ledger at "${path}" exists but could not be opened for reading. A WAL-mode ` +
        `database needs "${path}-wal" and "${path}-shm" beside it to be read without ` +
        'write access — check that they were archived along with it, and that the ' +
        'file itself is readable.',
      options,
    )
    this.path = path
  }
}

export class ReadOnlyLedgerError extends LedgerError {
  readonly path: string
  constructor(path: string) {
    super(
      'READ_ONLY',
      `Ledger at "${path}" was opened read-only. Reopen it without \`readonly\` to write.`,
    )
    this.path = path
  }
}

export class WalletNotFoundError extends LedgerError {
  readonly walletId: string
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `Wallet "${walletId}" does not exist. Create it with createWallet().`)
    this.walletId = walletId
  }
}

export class WalletAlreadyExistsError extends LedgerError {
  readonly walletId: string
  constructor(walletId: string) {
    super('WALLET_ALREADY_EXISTS', `Wallet "${walletId}" already exists.`)
    this.walletId = walletId
  }
}

export class InvalidArgumentError extends LedgerError {
  constructor(message: string) {
    super('INVALID_ARGUMENT', message)
  }
}

export class InvalidAmountError extends LedgerError {
  readonly value: unknown
  constructor(message: string, value: unknown) {
    super('INVALID_AMOUNT', message)
    this.value = value
  }
}

export class UnbalancedMovementError extends LedgerError {
  readonly currency: string
  readonly delta: number
  constructor(currency: string, delta: number) {
    super(
      'UNBALANCED_MOVEMENT',
      `Movement is not zero-sum for currency "${currency}": entries add up to ${delta}, expected 0.`,
    )
    this.currency = currency
    this.delta = delta
  }
}

export class CurrencyMismatchError extends LedgerError {
  constructor(message: string) {
    super('CURRENCY_MISMATCH', message)
  }
}

export class InsufficientFundsError extends LedgerError {
  readonly walletId: string
  readonly balance: number
  readonly attempted: number
  constructor(walletId: string, balance: number, attempted: number) {
    super(
      'INSUFFICIENT_FUNDS',
      `Wallet "${walletId}" would go negative: balance ${balance} ${attempted >= 0 ? '+' : '-'} ` +
        `${Math.abs(attempted)} = ${balance + attempted}. Create it with { allowNegative: true } if that is intended.`,
    )
    this.walletId = walletId
    this.balance = balance
    this.attempted = attempted
  }
}

export class IdempotencyConflictError extends LedgerError {
  readonly idempotencyKey: string
  constructor(idempotencyKey: string) {
    super(
      'IDEMPOTENCY_CONFLICT',
      `Idempotency key "${idempotencyKey}" was already used with a different payload. ` +
        'Reusing a key requires an identical set of entries.',
    )
    this.idempotencyKey = idempotencyKey
  }
}

export class IntegrityError extends LedgerError {
  constructor(message: string) {
    super('INTEGRITY_ERROR', message)
  }
}

export class SchemaVersionMismatchError extends LedgerError {
  constructor(found: number, expected: number) {
    super(
      'SCHEMA_VERSION_MISMATCH',
      `Database was written by izi-ledger schema v${found}, this build speaks v${expected}.`,
    )
  }
}
