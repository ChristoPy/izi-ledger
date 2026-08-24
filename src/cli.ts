import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parseArgs } from 'node:util'
import { audit } from './audit.js'
import { LedgerError } from './errors.js'
import type { Checkpoint, IntegrityIssue } from './types.js'

const USAGE = `izi-ledger audit <ledger.db> [options]

Verify a ledger file from the outside. Needs nothing but the file, the
checkpoints that were published, and the public key that signed them.

Options:
  --anchors <file>       JSON array (or one object, or JSON Lines) of published
                         checkpoints. Repeatable.
  --public-key <file>    PEM public key. Repeatable. Accepts <keyId>=<file>;
                         otherwise the file name is used as the key id.
  --wallet <id>          Walk one wallet's chain instead of the whole ledger.
  --json                 Machine-readable output.
  --help

Exits 0 when the ledger verifies, 1 when it does not.

Without --anchors this proves the ledger is internally consistent, which
anyone who can write to the file can also arrange. Anchors are what make the
result mean something to a third party.`

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`)
    return 2
  }

  const { values, positionals } = parsed
  if (values.help || positionals.length === 0) {
    process.stdout.write(`${USAGE}\n`)
    return values.help ? 0 : 2
  }

  const [command, path] = positionals
  if (command !== 'audit') {
    process.stderr.write(`Unknown command "${command}". Only "audit" exists.\n\n${USAGE}\n`)
    return 2
  }
  if (!path) {
    process.stderr.write(`audit needs a path to a ledger file.\n\n${USAGE}\n`)
    return 2
  }

  let anchors: Checkpoint[]
  let publicKeys: Record<string, string>
  try {
    anchors = (values.anchors ?? []).flatMap(readAnchors)
    publicKeys = Object.fromEntries((values['public-key'] ?? []).map(readPublicKey))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }

  try {
    const report = await audit({
      path,
      anchors,
      publicKeys,
      ...(values.wallet ? { walletId: values.wallet } : {}),
    })

    process.stdout.write(
      values.json ? `${JSON.stringify(report, null, 2)}\n` : render(report, path),
    )
    return report.ok ? 0 : 1
  } catch (error) {
    const message = error instanceof LedgerError ? `${error.code}: ${error.message}` : String(error)
    process.stderr.write(`Could not audit ${path}\n  ${message}\n`)
    return 2
  }
}

const OPTIONS = {
  anchors: { type: 'string', multiple: true },
  'public-key': { type: 'string', multiple: true },
  wallet: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const

function readAnchors(file: string): Checkpoint[] {
  const raw = readFileSync(file, 'utf8').trim()
  if (raw.length === 0) return []
  try {
    if (raw.startsWith('[')) return JSON.parse(raw) as Checkpoint[]
    if (raw.startsWith('{') && !raw.includes('\n{')) return [JSON.parse(raw) as Checkpoint]
    // JSON Lines: one checkpoint per line, which is what an append-only log
    // of published anchors naturally looks like.
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Checkpoint)
  } catch (error) {
    throw new Error(`Could not read anchors from ${file}: ${(error as Error).message}`)
  }
}

function readPublicKey(spec: string): [string, string] {
  const separator = spec.indexOf('=')
  const [keyId, file] =
    separator === -1
      ? [basename(spec, extname(spec)), spec]
      : [spec.slice(0, separator), spec.slice(separator + 1)]
  try {
    return [keyId, readFileSync(file, 'utf8')]
  } catch (error) {
    throw new Error(`Could not read public key ${file}: ${(error as Error).message}`)
  }
}

function render(report: Awaited<ReturnType<typeof audit>>, path: string): string {
  const lines: string[] = []
  const row = (label: string, status: string, detail: string) =>
    lines.push(`  ${label.padEnd(12)}${status.padEnd(8)}${detail}`)

  // Each row reports its own check. Marking every row red because one failed
  // would tell an auditor the wrong thing about which part of the proof broke.
  const failed = (category: IntegrityIssue['category']) =>
    report.issues.some((issue) => issue.category === category)

  lines.push(`${path}  ·  ${report.driver}`)
  lines.push('')
  row('ledger', failed('chain') ? 'FAILED' : 'ok', `${report.checked} movements re-hashed`)
  row(
    'anchors',
    report.anchorsChecked === 0 ? '—' : failed('anchor') ? 'FAILED' : 'ok',
    report.anchorsChecked === 0
      ? 'none supplied — internal consistency only'
      : `${report.anchorsChecked} checked`,
  )
  row(
    'signatures',
    report.signaturesChecked === 0 ? '—' : failed('signature') ? 'FAILED' : 'ok',
    report.signaturesChecked === 0
      ? 'no public keys supplied'
      : `${report.signaturesChecked} verified`,
  )
  const unbalanced = Object.entries(report.totals).filter(([, total]) => total !== 0)
  row(
    'zero-sum',
    unbalanced.length === 0 ? 'ok' : 'FAILED',
    Object.entries(report.totals)
      .map(([currency, total]) => `${currency}: ${total}`)
      .join(', ') || 'no movements',
  )
  row('ledger id', '', report.ledgerId ?? 'unknown (no anchors)')

  if (report.issues.length > 0) {
    lines.push('')
    lines.push(`${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}:`)
    for (const issue of report.issues.slice(0, 25)) lines.push(`  - ${issue.reason}`)
    if (report.issues.length > 25) lines.push(`  … and ${report.issues.length - 25} more`)
  }

  lines.push('')
  lines.push(report.ok ? 'VERIFIED' : 'NOT VERIFIED')
  return `${lines.join('\n')}\n`
}
