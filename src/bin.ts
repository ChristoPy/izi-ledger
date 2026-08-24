#!/usr/bin/env node
/**
 * The `izi-ledger` executable. Everything real lives in cli.ts, which stays a
 * plain module so the command can be tested without spawning a process.
 */
import { main } from './cli.js'

// Node prints an ExperimentalWarning for its built-in SQLite. That is an
// implementation detail of which driver we picked, and noise in a report an
// auditor reads, so drop just that one.
// Adding a listener does not stop Node's default one from printing, so the
// default has to go first.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
  process.stderr.write(`${warning.name}: ${warning.message}\n`)
})

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 2
  },
)
