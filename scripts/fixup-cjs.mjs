import { writeFileSync } from 'node:fs'

writeFileSync('dist/cjs/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`)
writeFileSync('dist/esm/package.json', `${JSON.stringify({ type: 'module' }, null, 2)}\n`)
