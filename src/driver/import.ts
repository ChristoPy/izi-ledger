/**
 * Dynamic import behind a runtime-built specifier.
 *
 * Bundlers (webpack, vite, esbuild) try to resolve static `import('bun:sqlite')`
 * at build time and fail on the runtime that does not have it. Passing the
 * specifier as a variable — plus the magic comments — keeps it external.
 */
export function dynamicImport(specifier: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)
}
