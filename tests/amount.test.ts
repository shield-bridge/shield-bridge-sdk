import { describe, it, expect } from 'vitest';
import BigNumber from 'bignumber.js';
import {
  toBaseUnits,
  fromBaseUnits,
  validateAmount,
} from '../src/utils/amount';

// =============================================================================
// toBaseUnits
// =============================================================================
describe('toBaseUnits', () => {
  it('converts XTZ to mutez (6 decimals)', () => {
    expect(toBaseUnits(1.5, 6)).toBe('1500000');
  });

  it('converts whole numbers', () => {
    expect(toBaseUnits(1, 6)).toBe('1000000');
    expect(toBaseUnits(0, 6)).toBe('0');
  });

  it('handles very small fractional amounts', () => {
    expect(toBaseUnits(0.000001, 6)).toBe('1');
    expect(toBaseUnits(0.1, 6)).toBe('100000');
  });

  it('handles tokens with 0 decimals', () => {
    expect(toBaseUnits(42, 0)).toBe('42');
    expect(toBaseUnits(1.9, 0)).toBe('2'); // rounds to nearest integer
  });

  it('handles tokens with 8 decimals (like BTC)', () => {
    expect(toBaseUnits(1, 8)).toBe('100000000');
    expect(toBaseUnits(0.00000001, 8)).toBe('1');
  });

  it('handles tokens with 18 decimals (like ETH)', () => {
    expect(toBaseUnits(1, 18)).toBe('1000000000000000000');
    expect(toBaseUnits('0.000000000000000001', 18)).toBe('1');
  });

  it('accepts string input', () => {
    expect(toBaseUnits('2.5', 6)).toBe('2500000');
    expect(toBaseUnits('100', 6)).toBe('100000000');
  });

  it('accepts BigNumber input', () => {
    expect(toBaseUnits(new BigNumber('1.5'), 6)).toBe('1500000');
  });

  it('handles large amounts without precision loss', () => {
    // ~21 billion tokens with 6 decimals
    expect(toBaseUnits('21000000000', 6)).toBe('21000000000000000');
  });

  it('truncates sub-unit fractions (rounds to nearest)', () => {
    // 1.9999999 XTZ → rounds to 2000000
    expect(toBaseUnits(1.9999999, 6)).toBe('2000000');
  });
});

// =============================================================================
// fromBaseUnits
// =============================================================================
describe('fromBaseUnits', () => {
  it('converts mutez to XTZ (6 decimals)', () => {
    expect(fromBaseUnits(1500000, 6)).toBe('1.5');
  });

  it('converts whole amounts', () => {
    expect(fromBaseUnits(1000000, 6)).toBe('1');
    expect(fromBaseUnits(0, 6)).toBe('0');
  });

  it('handles 1 mutez', () => {
    expect(fromBaseUnits(1, 6)).toBe('0.000001');
  });

  it('handles tokens with 0 decimals', () => {
    expect(fromBaseUnits(42, 0)).toBe('42');
  });

  it('handles tokens with 18 decimals', () => {
    expect(fromBaseUnits('1000000000000000000', 18)).toBe('1');
    expect(fromBaseUnits(1, 18)).toBe('0.000000000000000001');
  });

  it('returns a string (not a number) to preserve precision', () => {
    const result = fromBaseUnits('99999999999999999', 6);
    expect(typeof result).toBe('string');
    // If this were a number, precision would be lost
    expect(result).toBe('99999999999.999999');
  });

  it('accepts string input', () => {
    expect(fromBaseUnits('2500000', 6)).toBe('2.5');
  });

  it('accepts BigNumber input', () => {
    expect(fromBaseUnits(new BigNumber('1500000'), 6)).toBe('1.5');
  });

  it('does not produce trailing zeros beyond precision', () => {
    expect(fromBaseUnits(1000000, 6)).toBe('1'); // Not '1.000000'
    expect(fromBaseUnits(1100000, 6)).toBe('1.1'); // Not '1.100000'
  });
});

// =============================================================================
// toBaseUnits ↔ fromBaseUnits roundtrip
// =============================================================================
describe('toBaseUnits / fromBaseUnits roundtrip', () => {
  const cases: Array<[string, number]> = [
    ['1.5', 6],
    ['100', 6],
    ['0.000001', 6],
    ['1', 18],
    ['0.000000000000000001', 18],
    ['42', 0],
    ['12345.678', 8],
  ];

  it.each(cases)('roundtrips %s with %d decimals', (amount, decimals) => {
    const base = toBaseUnits(amount, decimals);
    const human = fromBaseUnits(base, decimals);
    expect(human).toBe(amount);
  });
});

// =============================================================================
// validateAmount
// =============================================================================
describe('validateAmount', () => {
  it('accepts valid positive amounts', () => {
    expect(() => validateAmount(1)).not.toThrow();
    expect(() => validateAmount(0.000001)).not.toThrow();
    expect(() => validateAmount('100.5')).not.toThrow();
    expect(() => validateAmount(new BigNumber('999'))).not.toThrow();
  });

  it('rejects NaN', () => {
    expect(() => validateAmount(NaN)).toThrow('valid number');
    expect(() => validateAmount('not-a-number')).toThrow('valid number');
  });

  it('rejects Infinity', () => {
    expect(() => validateAmount(Infinity)).toThrow('finite');
    expect(() => validateAmount(-Infinity)).toThrow('finite');
  });

  it('rejects zero', () => {
    expect(() => validateAmount(0)).toThrow('greater than 0');
    expect(() => validateAmount('0')).toThrow('greater than 0');
  });

  it('rejects negative amounts', () => {
    expect(() => validateAmount(-1)).toThrow('greater than 0');
    expect(() => validateAmount('-5.5')).toThrow('greater than 0');
  });

  it('includes custom context in error messages', () => {
    expect(() => validateAmount(0, 'Shield amount')).toThrow(
      'Shield amount must be greater than 0',
    );
    expect(() => validateAmount(NaN, 'Transfer value')).toThrow(
      'Transfer value must be a valid number',
    );
  });

  it('uses default context when not provided', () => {
    expect(() => validateAmount(0)).toThrow('Amount must be greater than 0');
  });
});
