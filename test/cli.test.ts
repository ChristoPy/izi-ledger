import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../src/cli.js'
import { ed25519Signer, generateSigningKeyPair } from '../src/signing.js'
import { cleanup, openLedger, raw, tempDbPath } from './helpers.js'

const dirs: string[] = []
afterEach(async () => {
  await cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'izi-cli-'))
  dirs.push(dir)
  return dir
}

/** Run the command with stdout/stderr captured, the way a shell would see it. */
async function run(args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const code = await main(args)
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
}

async function auditable() {
  const dir = scratch()
  const path = tempDbPath()
  const { privateKey, publicKey } = generateSigningKeyPair()
  const book = await openLedger({
    path,
    signer: ed25519Signer({ keyId: 'ledger-2026-01', privateKey }),
  })
  await book.createWallet({ id: 'gw', allowNegative: true })
  await book.createWallet('fees')
  const anchors = []
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 2; i++) {
      await book.addMovement(
        [
          { walletId: 'gw', amount: -100 },
          { walletId: 'fees', amount: 100 },
        ],
        `r${round}p${i}`,
      )
    }
    anchors.push(await book.checkpoint())
  }
  await book.close()

  const anchorFile = join(dir, 'anchors.json')
  const keyFile = join(dir, 'ledger-2026-01.pem')
  writeFileSync(anchorFile, JSON.stringify(anchors, null, 2))
  writeFileSync(keyFile, publicKey)
  return { path, anchorFile, keyFile, anchors }
}

describe('izi-ledger audit', () => {
  test('verifies a healthy ledger and exits 0', async () => {
    const { path, anchorFile, keyFile } = await auditable()
    const { code, out } = await run([
      'audit',
      path,
      '--anchors',
      anchorFile,
      '--public-key',
      keyFile,
    ])

    expect(code).toBe(0)
    expect(out).toContain('VERIFIED')
    expect(out).toContain('anchors     ok')
    expect(out).toContain('signatures  ok')
    expect(out).toContain('zero-sum    ok')
  })

  test('reports each check separately rather than failing them all together', async () => {
    const { path, anchorFile, keyFile } = await auditable()
    // Break the chain only. Anchors and signatures are untouched and must not
    // be reported as failures.
    raw(path, (db) => db.run('UPDATE movements SET amount = amount + 1 WHERE seq = 1'))

    const { code, out } = await run([
      'audit',
      path,
      '--anchors',
      anchorFile,
      '--public-key',
      keyFile,
    ])
    expect(code).toBe(1)
    expect(out).toContain('ledger      FAILED')
    expect(out).toContain('signatures  ok')
    expect(out).toContain('NOT VERIFIED')
  })

  test('says plainly when no anchors were supplied', async () => {
    const { path } = await auditable()
    const { code, out } = await run(['audit', path])
    expect(code).toBe(0)
    expect(out).toContain('none supplied — internal consistency only')
    expect(out).toContain('no public keys supplied')
  })

  test('emits JSON on request', async () => {
    const { path, anchorFile, keyFile } = await auditable()
    const { code, out } = await run([
      'audit',
      path,
      '--anchors',
      anchorFile,
      '--public-key',
      keyFile,
      '--json',
    ])
    expect(code).toBe(0)
    const report = JSON.parse(out)
    expect(report).toMatchObject({ ok: true, anchorsChecked: 2, signaturesChecked: 2, issues: [] })
    expect(report.totals).toEqual({ BRL: 0 })
  })

  test('takes a key id from the file name, or explicitly', async () => {
    const { path, anchorFile, keyFile } = await auditable()
    const explicit = await run([
      'audit',
      path,
      '--anchors',
      anchorFile,
      '--public-key',
      `ledger-2026-01=${keyFile}`,
    ])
    expect(explicit.code).toBe(0)
  })

  test('reads anchors written as JSON Lines', async () => {
    const { path, anchors, keyFile } = await auditable()
    const dir = scratch()
    const file = join(dir, 'anchors.jsonl')
    writeFileSync(file, `${anchors.map((a) => JSON.stringify(a)).join('\n')}\n`)
    const { code } = await run(['audit', path, '--anchors', file, '--public-key', keyFile])
    expect(code).toBe(0)
  })

  test('restricts the walk to one wallet', async () => {
    const { path } = await auditable()
    const { code, out } = await run(['audit', path, '--wallet', 'fees'])
    expect(code).toBe(0)
    expect(out).toContain('4 movements re-hashed')
  })

  test('a missing ledger is an error, not an empty one that verifies', async () => {
    // The usage-error case below passes a path whose *directory* is missing, so
    // it fails for an unrelated reason. A typo in the file name lands in a
    // directory that exists, which is what a CI gate actually hits.
    const path = join(scratch(), 'ledger-2026.db')
    const { code, out, err } = await run(['audit', path])
    expect(code).toBe(2)
    expect(err).toContain('LEDGER_NOT_FOUND')
    expect(out).not.toContain('VERIFIED')
    expect(existsSync(path)).toBe(false)
  })

  test('writes nothing beside an artefact archived without its sidecars', async () => {
    // A ledger archived as the .db alone. Read-write, the audit opens it,
    // reports on whatever that file happens to hold, and leaves a -wal and a
    // -shm next to the artefact. Refusing is the honest answer: the movements
    // may still be in the -wal that was never copied.
    const { path: source } = await auditable()
    const path = join(scratch(), 'archived.db')
    copyFileSync(source, path)

    const { code, out, err } = await run(['audit', path])
    expect(code).toBe(2)
    expect(err).toContain('LEDGER_UNREADABLE')
    expect(out).not.toContain('VERIFIED')
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
  })

  test('exits 2 on usage errors, not 1', async () => {
    expect((await run([])).code).toBe(2)
    expect((await run(['audit'])).code).toBe(2)
    expect((await run(['nonsense', 'x.db'])).code).toBe(2)
    expect((await run(['audit', '/does/not/exist.db'])).code).toBe(2)
    expect((await run(['audit', 'x.db', '--anchors', '/missing.json'])).code).toBe(2)
  })

  test('--help explains itself and exits 0', async () => {
    const { code, out } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('izi-ledger audit')
    expect(out).toContain('Anchors are what make the')
  })
})
