export { type AuditOptions, type AuditReport, audit } from './audit.js'
export { canonicalJson, HASH_VERSION, movementHash } from './canonical.js'
export { CHECKPOINT_VERSION, checkpointHashMatches } from './checkpoint.js'
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
  LedgerNotFoundError,
  LedgerUnreadableError,
  ReadOnlyLedgerError,
  SchemaVersionMismatchError,
  UnbalancedMovementError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from './errors.js'
export { ledger, ledger as createLedger } from './ledger.js'
export { SCHEMA_VERSION } from './schema.js'
export {
  ed25519Signer,
  generateSigningKeyPair,
  type SignatureCheck,
  verifyCheckpointSignature,
} from './signing.js'
export type {
  AddMovementOptions,
  Checkpoint,
  CheckpointSignature,
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

import { ledger } from './ledger.js'
export default ledger
