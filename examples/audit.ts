/**
 * The full checkpoint loop: sign, publish, and audit from outside.
 *
 *   bun run examples/audit.ts
 *
 * Writes anchors.json and a public key to a temp directory, then shows what an
 * auditor sees before and after somebody rewrites the book.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audit, ledger } from '../src/index.js'
import { ed25519Signer, generateSigningKeyPair } from '../src/signing.js'

const dir = mkdtempSync(join(tmpdir(), 'izi-ledger-audit-'))
const path = join(dir, 'ledger.db')

// The private key would live in a KMS in anything real; the auditor only ever
// needs the public half.
const { privateKey, publicKey } = generateSigningKeyPair()
writeFileSync(join(dir, 'ledger-2026-01.pem'), publicKey)

const book = await ledger({
  path,
  signer: ed25519Signer({ keyId: 'ledger-2026-01', privateKey }),
})
await book.createWallet({ id: 'external:pix', allowNegative: true })
await book.createWallet({ id: 'user:alice' })

const anchors = []
for (let day = 1; day <= 3; day++) {
  for (let i = 0; i < 3; i++) {
    await book.addMovement(
      [
        { walletId: 'external:pix', amount: -100_00 },
        { walletId: 'user:alice', amount: 100_00 },
      ],
      `day${day}:deposit${i}`,
    )
  }
  // End of day: commit to the book so far and send it somewhere out of reach.
  const anchor = await book.checkpoint()
  anchors.push(anchor)
  console.log(
    `day ${day}  seq ${String(anchor.seq).padStart(2)}  ${anchor.hash.slice(0, 16)}…  signed by ${anchor.signature?.keyId}`,
  )
}
writeFileSync(join(dir, 'anchors.json'), JSON.stringify(anchors, null, 2))
await book.close()

const report = await audit({
  path,
  anchors,
  publicKeys: { 'ledger-2026-01': publicKey },
})
console.log('\nauditor:', report.ok ? 'VERIFIED' : 'NOT VERIFIED')
console.log(
  `  ${report.checked} movimentações, ${report.anchorsChecked} âncoras, ${report.signaturesChecked} assinaturas`,
)
console.log(
  `\nreproduce it yourself:\n  npx izi-ledger audit ${path} \\\n    --anchors ${join(dir, 'anchors.json')} \\\n    --public-key ${join(dir, 'ledger-2026-01.pem')}`,
)

if (!report.ok) process.exit(1)
