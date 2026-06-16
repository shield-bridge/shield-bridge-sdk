/**
 * Unit tests for notesToHistory — the rcm-based "self-sent / change" detection that lets the app
 * separate real receives/sends from internal change. Network-free: synthetic raw notes.
 */
import { describe, it, expect } from 'vitest';
import { notesToHistory, type RawSaplingNote } from '../src/saplingCore';

const rcm = (id: number) => new Uint8Array(32).fill(id);
const addr = () => new Uint8Array(43).fill(7); // 43-byte sapling address (11 diversifier + 32 pkd)
const valBytes = (mutez: number) => {
  let hex = mutez.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Uint8Array.from(Buffer.from(hex, 'hex'));
};
const note = (id: number, mutez: number, isSpent = false): RawSaplingNote => ({
  value: valBytes(mutez),
  memo: new Uint8Array(0),
  paymentAddress: addr(),
  randomCommitmentTrapdoor: rcm(id),
  isSpent,
});

describe('notesToHistory — rcm-based change detection', () => {
  it('flags notes present in BOTH lists (self-sent change) on both sides, exactly', () => {
    // rcm 2 appears in incoming AND outgoing → change. 1,3 are incoming-only; 4 is outgoing-only.
    const raw = {
      incoming: [note(1, 5_000_000), note(2, 78_099_858, true), note(3, 0)],
      outgoing: [note(2, 78_099_858), note(4, 12_000_000)],
    };
    const h = notesToHistory(raw);
    expect(h.incoming.map((n) => n.isChange)).toEqual([false, true, false]);
    expect(h.outgoing.map((n) => n.isChange)).toEqual([true, false]);
  });

  it('decodes value (base-16 bytes → mutez), empty memo, a zet1 address, and isSpent', () => {
    const h = notesToHistory({ incoming: [note(1, 5_000_000, true)], outgoing: [] });
    expect(h.incoming[0].value).toBe(5_000_000);
    expect(h.incoming[0].memo).toBe('');
    expect(h.incoming[0].paymentAddress.startsWith('zet1')).toBe(true);
    expect(h.incoming[0].isSpent).toBe(true);
    expect(h.incoming[0].isChange).toBe(false);
  });

  it('decodes a memo from utf8 with trailing zero-padding stripped', () => {
    const memo = Uint8Array.from(Buffer.from('4869000000', 'hex')); // "Hi" + 00-padding
    const h = notesToHistory({ incoming: [{ ...note(1, 1), memo }], outgoing: [] });
    expect(h.incoming[0].memo).toBe('Hi');
  });
});
