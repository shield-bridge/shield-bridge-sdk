import BigNumber from 'bignumber.js';
import type { AmountInput } from '../types.js';

/**
 * Convert a human-readable amount to base units (mutez / smallest token unit).
 *
 * Accepts number, string, or BigNumber as input.
 *
 * @param amount  - Human-readable amount (e.g. 1.5 for 1.5 XTZ)
 * @param decimals - Number of decimals for the token (6 for XTZ/mutez)
 * @returns The amount in base units as a string (safe for the RPC)
 */
export function toBaseUnits(amount: AmountInput, decimals: number): string {
  const bn = new BigNumber(amount.toString());
  return bn.times(new BigNumber(10).exponentiatedBy(decimals)).toFixed(0);
}

/**
 * Convert a base-unit amount to human-readable form.
 *
 * Returns a string to prevent JavaScript floating-point precision loss
 * for large values (numbers only have ~15-17 significant digits).
 *
 * @param amount   - Amount in base units (e.g. 1_500_000 mutez)
 * @param decimals - Number of decimals for the token (6 for XTZ)
 * @returns The human-readable amount as a string (lossless precision)
 */
export function fromBaseUnits(amount: AmountInput, decimals: number): string {
  return new BigNumber(amount.toString())
    .dividedBy(new BigNumber(10).exponentiatedBy(decimals))
    .toFixed();
}

/**
 * Validate that an amount is positive, finite, and not NaN.
 *
 * @param amount - The amount to validate
 * @param context - Description of the amount for error messages
 * @throws {Error} If amount is invalid
 */
export function validateAmount(
  amount: AmountInput,
  context: string = 'Amount',
): void {
  const bn = new BigNumber(amount.toString());
  if (bn.isNaN()) {
    throw new Error(`${context} must be a valid number, got NaN`);
  }
  if (!bn.isFinite()) {
    throw new Error(`${context} must be finite, got ${bn.toString()}`);
  }
  if (bn.isLessThanOrEqualTo(0)) {
    throw new Error(`${context} must be greater than 0, got ${bn.toString()}`);
  }
}
