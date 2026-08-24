export type LedgerErrorCode =
  | 'DRIVER_UNAVAILABLE'
  | 'LEDGER_CLOSED'
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
