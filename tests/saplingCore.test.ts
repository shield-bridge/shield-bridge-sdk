/**
 * Unit tests for the loadSaplingSecret idempotency cache in saplingCore.
 *
 * A pooled worker is reused across operations with an unchanging key. The cache
 * skips re-deriving the spending key (InMemorySpendingKey.fromMnemonic) and
 * rebuilding the SaplingToolkit when the same key/contract/rpc is reloaded.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemorySpendingKey } from '@tezos-x/octez.js-sapling';
import { saplingWorkerCore } from '../src/saplingCore';

// Deterministic BIP39 "zero" mnemonic — standard test vector.
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const RPC_URL = 'https://mainnet.api.tez.ie';
const SET_A = 'KT1Q81ZGgciw6tLfbwuPuYiJ8WyxkwzJeESQ';
const SET_B = 'KT1WqGXxe5Anam6Hm6zQqGmaXdtZrzZRynnw';

const load = (contractAddress: string) =>
  saplingWorkerCore.loadSaplingSecret({
    sk: TEST_MNEMONIC,
    skType: 'mnemonic',
    saplingDetails: { contractAddress, memoSize: 8 },
    rpcUrl: RPC_URL,
  });

afterEach(() => {
  // Reset singleton state so each test starts cold.
  saplingWorkerCore.reInitializeSapling();
  vi.restoreAllMocks();
});

describe('saplingCore.loadSaplingSecret idempotency', () => {
  it('derives the key once when reloaded with identical key/contract/rpc', async () => {
    const spy = vi.spyOn(InMemorySpendingKey, 'fromMnemonic');

    await load(SET_A);
    await load(SET_A);

    expect(spy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('re-derives when the contract changes', async () => {
    const spy = vi.spyOn(InMemorySpendingKey, 'fromMnemonic');

    await load(SET_A);
    await load(SET_B);

    expect(spy).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('re-derives after reInitializeSapling invalidates the cache', async () => {
    const spy = vi.spyOn(InMemorySpendingKey, 'fromMnemonic');

    await load(SET_A);
    saplingWorkerCore.reInitializeSapling();
    await load(SET_A);

    expect(spy).toHaveBeenCalledTimes(2);
  }, 30_000);
});
