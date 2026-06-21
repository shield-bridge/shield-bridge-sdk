/**
 * Unit tests for realignEstimatesForReveal — the reveal-aware realignment of an octez.js
 * `estimate.batch()` result. For an UNREVEALED source, octez auto-prepends a reveal and returns its
 * Estimate as element [0] (without shifting it off, unlike its single-op estimators). Since the SDK
 * pins gas/storage/fee positionally per op, that stray leading reveal estimate mis-gasses every op
 * and the node rejects with gas_exhausted/fees_too_low. This helper drops it so the array maps 1:1
 * onto the ops; it must be a no-op for an already-revealed source.
 */
import { describe, it, expect } from 'vitest';
import { realignEstimatesForReveal } from '../src/index';

describe('realignEstimatesForReveal', () => {
  it('drops the leading reveal estimate when the source is unrevealed (length === ops + 1)', () => {
    // [revealEstimate, op0, op1] for 2 ops -> [op0, op1]
    expect(realignEstimatesForReveal(['REVEAL', 'op0', 'op1'], 2)).toEqual(['op0', 'op1']);
    // single op: [reveal, op0] -> [op0]
    expect(realignEstimatesForReveal(['REVEAL', 'op0'], 1)).toEqual(['op0']);
  });

  it('returns the array unchanged for an already-revealed source (length === ops)', () => {
    const revealed = ['op0', 'op1', 'op2'];
    expect(realignEstimatesForReveal(revealed, 3)).toEqual(revealed);
    expect(realignEstimatesForReveal(['op0'], 1)).toEqual(['op0']);
    expect(realignEstimatesForReveal([], 0)).toEqual([]);
  });

  it('realigns 1:1 so each op gets ITS OWN estimate (the bug was an off-by-one)', () => {
    // Tag the reveal vs op estimates; after realignment, index i must map to op i, not op i-1.
    const out = realignEstimatesForReveal(['reveal', 'estA', 'estB', 'estC'], 3);
    expect(out[0]).toBe('estA');
    expect(out[1]).toBe('estB');
    expect(out[2]).toBe('estC');
  });

  it('does NOT slice on an unexpected length mismatch (guard is exactly ops + 1)', () => {
    // Defensive: only the documented "+1 reveal" shape is realigned; anything else is left as-is
    // rather than silently corrupting the mapping.
    const weird = ['a', 'b', 'c', 'd'];
    expect(realignEstimatesForReveal(weird, 2)).toBe(weird); // length ops+2 -> untouched
  });
});
