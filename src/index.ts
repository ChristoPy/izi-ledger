export { canonicalJson, HASH_VERSION, movementHash } from './canonical.js'
export { availableDrivers } from './driver/index.js'
export type { DriverName } from './driver/types.js'
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
  type LedgerErrorCode,
  SchemaVersionMismatchError,
  UnbalancedMovementError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from './errors.js'
export { ledger, ledger as createLedger } from './ledger.js'
export { SCHEMA_VERSION } from './schema.js'
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
