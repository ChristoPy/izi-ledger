import { InvalidAmountError } from './errors.js'

/**
 * Amounts are signed integers in the currency's minor unit (cents), so the
 * arithmetic is exact. `Number.isSafeInteger` is the hard boundary: past
 * 2^53-1 addition silently stops being associative.
 */
export function assertAmount(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number') {
    throw new InvalidAmountError(
      `${label} must be a number in minor units (cents), got ${typeof value}.`,
      value,
    )
  }
  if (!Number.isFinite(value)) {
    throw new InvalidAmountError(`${label} must be finite, got ${value}.`, value)
  }
  if (!Number.isInteger(value)) {
    throw new InvalidAmountError(
      `${label} must be an integer in minor units (cents), got ${value}. ` +
        'Use 1050 for 10.50, not 10.5.',
      value,
    )
  }
  if (!Number.isSafeInteger(value)) {
    throw new InvalidAmountError(
      `${label} exceeds the safe integer range (${Number.MAX_SAFE_INTEGER}), got ${value}.`,
      value,
    )
  }
  // -0 hashes and compares awkwardly; normalise it away at the boundary.
  if (Object.is(value, -0)) {
    throw new InvalidAmountError(`${label} must not be -0.`, value)
  }
}

/** Add two amounts, refusing to produce a balance that is no longer exact. */
export function addExact(balance: number, amount: number, label: string): number {
  const next = balance + amount
  if (!Number.isSafeInteger(next)) {
    throw new InvalidAmountError(
      `${label} would overflow the safe integer range: ${balance} + ${amount} = ${next}.`,
      next,
    )
  }
  return next
}
