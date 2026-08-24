/**
 * `bun test` for bun:sqlite, then the Node conformance suite against dist/ for
 * node:sqlite and better-sqlite3.
 */
import { spawnSync } from 'node:child_process'

const steps = [
  ['bun', ['test']],
  ['bun', ['run', 'build']],
  ['node', ['--no-warnings', '--test', 'scripts/test-node-drivers.mjs']],
]

for (const [command, args] of steps) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
