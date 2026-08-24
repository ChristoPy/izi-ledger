/**
 * Child process for the crash-safety test: writes transactions in a loop and
 * announces each commit on stdout so the parent can SIGKILL it mid-stream.
 */
import { ledger } from '../../src/index.js'

const path = process.argv[2]!
const book = await ledger({ path, durability: 'full' })

await book.createWallet({ id: 'gateway', allowNegative: true })
await book.createWallet('fees')

for (let i = 0; i < 100_000; i++) {
  await book.addMovement(
    [
      { walletId: 'gateway', amount: -10 },
      { walletId: 'fees', amount: 10 },
    ],
    `crash:${i}`,
  )
  process.stdout.write(`committed ${i}\n`)
  await new Promise((resolve) => setTimeout(resolve, 1))
}
