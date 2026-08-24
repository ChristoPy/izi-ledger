/**
 * A small payments book, end to end: deposit with a fee, transfer, refund,
 * a retried request, a statement, and an integrity check.
 *
 *   bun run example
 *
 * Runs against an in-memory database, so it leaves nothing behind, and exits
 * non-zero if the ledger fails to verify — CI runs it as a smoke test of the
 * public API from a consumer's side.
 */
import { InsufficientFundsError, ledger } from '../src/index.js'

const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const book = await ledger({ path: ':memory:', defaultCurrency: 'BRL' })

// ---------------------------------------------------------------- the accounts
// Clearing and revenue accounts hold the other side of user money, so they are
// the ones allowed to go negative. User wallets are not.
await book.createWallet({ id: 'external:pix', allowNegative: true, metadata: { type: 'clearing' } })
await book.createWallet({ id: 'revenue:fees', allowNegative: true, metadata: { type: 'revenue' } })
await book.createWallet({ id: 'user:alice' })
await book.createWallet({ id: 'user:bob' })

// ------------------------------------------------------------------- a deposit
// R$ 100,00 arrives; we keep R$ 2,50. Three entries, one atomic fact.
await book.addMovement(
  [
    { walletId: 'external:pix', amount: -100_00 },
    { walletId: 'user:alice', amount: 97_50 },
    { walletId: 'revenue:fees', amount: 2_50 },
  ],
  { idempotencyKey: 'deposit:e2e-123', metadata: { psp: 'pix', endToEndId: 'E123' } },
)
console.log(`deposit      alice ${brl(await book.getBalance('user:alice'))}`)

// ------------------------------------------------------------------ a retry
// The PSP webhook fires twice. The second call writes nothing.
const retry = await book.addMovement(
  [
    { walletId: 'external:pix', amount: -100_00 },
    { walletId: 'user:alice', amount: 97_50 },
    { walletId: 'revenue:fees', amount: 2_50 },
  ],
  { idempotencyKey: 'deposit:e2e-123', metadata: { psp: 'pix', endToEndId: 'E123' } },
)
console.log(
  `retry        replayed: ${retry.replayed}, alice still ${brl(await book.getBalance('user:alice'))}`,
)

// ----------------------------------------------------------------- a transfer
await book.addMovement(
  [
    { walletId: 'user:alice', amount: -30_00 },
    { walletId: 'user:bob', amount: 29_00 },
    { walletId: 'revenue:fees', amount: 1_00 },
  ],
  'transfer:alice-bob:1',
)
console.log(
  `transfer     alice ${brl(await book.getBalance('user:alice'))}, bob ${brl(await book.getBalance('user:bob'))}`,
)

// ------------------------------------------------------------ an overdraft
// Bob has R$ 29,00. The whole transaction is refused and rolled back.
try {
  await book.addMovement(
    [
      { walletId: 'user:bob', amount: -50_00 },
      { walletId: 'user:alice', amount: 50_00 },
    ],
    'transfer:bob-alice:1',
  )
} catch (error) {
  if (!(error instanceof InsufficientFundsError)) throw error
  console.log(`overdraft    refused: bob has ${brl(error.balance)}, tried ${brl(error.attempted)}`)
}

// -------------------------------------------------------------------- a refund
// Nothing is ever deleted; a refund is a new movement in the other direction.
await book.addMovement(
  [
    { walletId: 'user:bob', amount: -29_00 },
    { walletId: 'revenue:fees', amount: -1_00 },
    { walletId: 'user:alice', amount: 30_00 },
  ],
  { idempotencyKey: 'refund:transfer:alice-bob:1', metadata: { refunds: 'transfer:alice-bob:1' } },
)
console.log(
  `refund       alice ${brl(await book.getBalance('user:alice'))}, bob ${brl(await book.getBalance('user:bob'))}`,
)

// ----------------------------------------------------------------- a statement
console.log('\nstatement — user:alice')
for (const movement of await book.listMovements({ walletId: 'user:alice' })) {
  const sign = movement.amount < 0 ? '-' : '+'
  console.log(
    `  #${String(movement.walletSeq).padStart(2)}  ${sign}${brl(Math.abs(movement.amount)).padStart(12)}` +
      `  balance ${brl(movement.balance).padStart(12)}  ${movement.hash.slice(0, 12)}…`,
  )
}

// -------------------------------------------------------------------- integrity
const [whole, forAlice] = await Promise.all([book.verify(), book.verify('user:alice')])
const totals = (await book.listMovements()).reduce((sum, m) => sum + m.amount, 0)
const stats = await book.stats()

console.log('\nintegrity')
console.log(`  ledger        ${whole.ok ? 'ok' : 'BROKEN'} (${whole.checked} movements re-hashed)`)
console.log(
  `  user:alice    ${forAlice.ok ? 'ok' : 'BROKEN'} (${forAlice.checked} movements re-hashed)`,
)
console.log(`  zero-sum      every amount adds up to ${totals}`)
console.log(`  driver        ${stats.driver}`)
console.log(`  cache         ${stats.cache.hits} hits / ${stats.cache.misses} misses`)

await book.close()

if (!whole.ok || !forAlice.ok || totals !== 0) process.exit(1)
