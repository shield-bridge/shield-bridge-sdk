/**
 * Cross-validation harness: validates the wire-format layout of a Shield
 * sapling_transaction produced by the reference `@tezos-x/octez.js-sapling`
 * SDK. The same structural fields are what `sapling-native::prepare_shield`
 * emits on Android/iOS, so this test acts as the canonical reference that
 * the Rust integration tests must match.
 *
 * Layout under test (from prepare_shield, lib.rs:1351-1361):
 *   [spends_count u32 BE]
 *   [spends_bytes]
 *   [outputs_count u32 BE]
 *   [outputs_bytes]
 *   [binding_sig 64]
 *   [value_balance i64 BE]
 *   [anchor 32]
 *   [bound_data_len u32 BE]
 *   [bound_data]
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  InMemorySpendingKey,
  SaplingToolkit,
} from '@tezos-x/octez.js-sapling';

// Deterministic BIP39 "zero" mnemonic — standard test vector.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Arbitrary KT1; not touched on-chain — only used for SaplingToolkit
// validation of the contract address format.
const FAKE_CONTRACT = 'KT1Q81ZGgciw6tLfbwuPuYiJ8WyxkwzJeESQ';

// Mocked merkle root for the empty sapling state.
const FAKE_ROOT_HEX = '00'.repeat(32);

const MEMO_SIZE = 8;

/**
 * Minimal TzReadProvider stub. SaplingToolkit.prepareShieldedTransaction only
 * reaches into `getSaplingDiffByContract` (verified by reading the bundled
 * SDK source at node_modules/@tezos-x/octez.js-sapling/dist/octez.js-sapling.es6.js).
 */
const FAKE_CHAIN_ID = 'NetXdQprcVkpaWU'; // mainnet chain id

const fakeReadProvider = {
  async getChainId() {
    return FAKE_CHAIN_ID;
  },
  async getSaplingDiffByContract(_contract: string, _block: string) {
    return {
      root: FAKE_ROOT_HEX,
      commitments_and_ciphertexts: [],
      nullifiers: [],
    };
  },
} as unknown as ConstructorParameters<typeof SaplingToolkit>[2];

let recipientZet1: string;
let toolkit: SaplingToolkit;

beforeAll(async () => {
  const signer = await InMemorySpendingKey.fromMnemonic(TEST_MNEMONIC);
  const viewer = await signer.getSaplingViewingKeyProvider();
  ({ address: recipientZet1 } = await viewer.getAddress());

  toolkit = new SaplingToolkit(
    { saplingSigner: signer },
    { contractAddress: FAKE_CONTRACT, memoSize: MEMO_SIZE },
    fakeReadProvider,
  );
}, 30_000);

describe('Reference SDK: Shield wire layout', () => {
  it(
    'prepareShieldedTransaction produces a well-formed sapling_transaction',
    async () => {
      const VALUE_MUTEZ = 1_000_000; // 1 XTZ in mutez

      const hex = await toolkit.prepareShieldedTransaction([
        { to: recipientZet1, amount: VALUE_MUTEZ.toString(), mutez: true },
      ]);

      expect(hex).toMatch(/^[0-9a-f]+$/);
      const bytes = Buffer.from(hex, 'hex');

      let off = 0;

      // 1) spends_count (u32 BE) — Shield has no spends
      const spendsLen = bytes.readUInt32BE(off);
      off += 4;
      expect(spendsLen).toBe(0);

      // 2) spends_bytes (empty for shield)
      off += spendsLen;

      // 3) outputs_count (u32 BE) — number of bytes in outputs region
      const outputsLen = bytes.readUInt32BE(off);
      off += 4;
      // A single output description is several hundred bytes (cv 32 + cmu 32 +
      // ek 32 + enc_ciphertext + out_ciphertext 80 + proof 192). Lower-bound
      // is comfortably > 300.
      expect(outputsLen).toBeGreaterThan(300);
      expect(outputsLen).toBeLessThan(2000);

      // 4) outputs_bytes
      off += outputsLen;

      // 5) binding_sig (64 bytes)
      const bindingSig = bytes.subarray(off, off + 64);
      off += 64;
      expect(bindingSig.length).toBe(64);
      // Binding sig should not be all zeros.
      expect(bindingSig.every((b) => b === 0)).toBe(false);

      // 6) value_balance (i64 BE) — negative for Shield (funds flowing IN
      //    means value_balance = -value).
      const valueBalance = bytes.readBigInt64BE(off);
      off += 8;
      expect(valueBalance).toBe(BigInt(-VALUE_MUTEZ));

      // 7) anchor (32 bytes) — must equal the root the mock returned.
      const anchor = bytes.subarray(off, off + 32);
      off += 32;
      expect(anchor.toString('hex')).toBe(FAKE_ROOT_HEX);

      // 8) bound_data_len (u32 BE) — Shield uses empty bound data.
      const boundDataLen = bytes.readUInt32BE(off);
      off += 4;
      expect(boundDataLen).toBe(0);

      // 9) No trailing bytes — every byte accounted for.
      expect(off).toBe(bytes.length);
    },
    120_000,
  );
});
