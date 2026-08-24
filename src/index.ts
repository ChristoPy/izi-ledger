export { ledger, ledger as createLedger } from './ledger.js'
export { availableDrivers } from './driver/index.js'
export { SCHEMA_VERSION } from './schema.js'
export { canonicalJson, movementHash, HASH_VERSION } from './canonical.js'
export {
  CurrencyMismatchError,
  DriverUnavailableError,
  IdempotencyConflictError,
  InsufficientFundsError,
  IntegrityError,
  InvalidAmountError,
  InvalidArgumentError,
  LedgerClosedError,
  LedgerError,
  SchemaVersionMismatchError,
  UnbalancedMovementError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  type LedgerErrorCode,
} from './errors.js'
export type { DriverName } from './driver/types.js'
export type {
  AddMovementOptions,
  CreateWalletOptions,
  IntegrityIssue,
  Ledger,
  LedgerOptions,
  LedgerStats,
  ListMovementsOptions,
  Metadata,
  Movement,
  MovementInput,
  TransactionResult,
  VerifyResult,
  Wallet,
} from './types.js'

import { ledger } from './ledger.js'
export default ledger
