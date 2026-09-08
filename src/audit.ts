import type { DriverName } from './driver/types.js'
import { ledger } from './ledger.js'
import type { Checkpoint, IntegrityIssue } from './types.js'

export interface AuditOptions {
  /** Path to the ledger file. */
  path: string
  /** Checkpoints recovered from wherever they were published. */
  anchors?: Checkpoint[]
  /** Public keys by key id, PEM encoded. */
  publicKeys?: Record<string, string>
  /** Restrict the chain walk to one wallet. */
  walletId?: string
  driver?: DriverName
}

export interface AuditReport {
  ok: boolean
  ledgerId: string | null
  driver: DriverName
  movements: number
  wallets: number
  transactions: number
  /** Movements re-hashed. */
  checked: number
  anchorsChecked: number
  signaturesChecked: number
  headHash: string | null
  totals: Record<string, number>
  issues: IntegrityIssue[]
}

/**
 * Verify a ledger file from the outside.
 *
 * Everything this needs is the file, the checkpoints that were published, and
 * the public half of whatever key signed them — no application code, no
 * secrets. That is the whole point of signing checkpoints: without a path like
 * this one, the signature proves nothing to anybody but the signer.
 */
export async function audit(options: AuditOptions): Promise<AuditReport> {
  const anchors = options.anchors ?? []
  const publicKeys = options.publicKeys ?? {}

  const book = await ledger({
    path: options.path,
    ...(options.driver ? { driver: options.driver } : {}),
    cacheSize: 0,
    // An auditor must not be able to change what it is auditing — including by
    // creating it. Read-write, this call makes an empty ledger out of any path
    // that has no file at it, and an empty ledger passes every check below.
    readonly: true,
  })

  try {
    const [result, stats, movements] = await Promise.all([
      book.verify({
        ...(options.walletId ? { walletId: options.walletId } : {}),
        anchors,
        publicKeys,
      }),
      book.stats(),
      book.listMovements(),
    ])

    const totals: Record<string, number> = {}
    for (const movement of movements) {
      totals[movement.currency] = (totals[movement.currency] ?? 0) + movement.amount
    }

    // A local checkpoint proves nothing on its own — it was written by whoever
    // wrote the rest of the file. Only the ones handed in from outside count.
    const signaturesChecked =
      Object.keys(publicKeys).length > 0 ? anchors.filter((a) => a.signature).length : 0

    return {
      ok: result.ok,
      ledgerId: anchors[0]?.ledgerId ?? null,
      driver: stats.driver,
      movements: stats.movements,
      wallets: stats.wallets,
      transactions: stats.transactions,
      checked: result.checked,
      anchorsChecked: anchors.length,
      signaturesChecked,
      headHash: stats.headHash,
      totals,
      issues: result.issues,
    }
  } finally {
    await book.close()
  }
}
