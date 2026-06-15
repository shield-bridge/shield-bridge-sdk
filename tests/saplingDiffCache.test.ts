/**
 * Unit tests for the incremental sapling-diff cache (saplingDiffCache.ts).
 *
 * Network-free: a mocked `fetch` serves a synthetic append-only pool's `get_diff` with offset
 * support at two heights (head~2 = finalized, head = current). Verifies that the caching read
 * provider reconstructs the exact head diff from a persisted finalized prefix + a fresh tail,
 * never persists the unconfirmed tail, fetches only the delta on a warm read, and delegates /
 * falls back to the wrapped adapter for non-head reads and on error.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  makeCachingReadProvider,
  MemoryDiffStore,
  type CachedSaplingDiff,
} from '../src/saplingDiffCache';

const RPC = 'https://rpc.example/mainnet';
const SET = 'KT1TestSet';
const KEY = `rpc.example|contract:${SET}`;

type Pool = {
  finalizedC: number;
  finalizedN: number;
  headC: number;
  headN: number;
  commitments: string[];
  nullifiers: string[];
};

const makePool = (): Pool => ({
  finalizedC: 5,
  finalizedN: 3,
  headC: 7, // 2 unconfirmed commitments beyond finalized
  headN: 4, // 1 unconfirmed nullifier beyond finalized
  commitments: Array.from({ length: 64 }, (_, i) => `c${i}`),
  nullifiers: Array.from({ length: 64 }, (_, i) => `n${i}`),
});

const installFetch = (pool: Pool, calls: string[]) => {
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const finalized = url.includes('head~2'); // checked before 'head' (substring)
    const offC = Number(u.searchParams.get('offset_commitment') ?? 0);
    const offN = Number(u.searchParams.get('offset_nullifier') ?? 0);
    const cEnd = finalized ? pool.finalizedC : pool.headC;
    const nEnd = finalized ? pool.finalizedN : pool.headN;
    return {
      ok: true,
      json: async () => ({
        root: finalized ? 'root@finalized' : 'root@head',
        commitments_and_ciphertexts: pool.commitments.slice(offC, cEnd),
        nullifiers: pool.nullifiers.slice(offN, nEnd),
      }),
    };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
};

// A fetch that returns `failCount` rate-limit/error responses before serving the pool normally.
// Used to exercise the retry/backoff path without real network. `Infinity` = always fail.
const installFlakyFetch = (
  pool: Pool,
  failCount: number,
  status = 429,
  retryAfter?: string,
) => {
  let n = 0;
  const fn = vi.fn(async (url: string) => {
    n += 1;
    if (n <= failCount) {
      return {
        ok: false,
        status,
        statusText: 'rate-limited',
        headers: {
          get: (h: string) => (h.toLowerCase() === 'retry-after' ? retryAfter ?? null : null),
        },
        json: async () => ({}),
      };
    }
    const u = new URL(url);
    const finalized = url.includes('head~2');
    const offC = Number(u.searchParams.get('offset_commitment') ?? 0);
    const offN = Number(u.searchParams.get('offset_nullifier') ?? 0);
    const cEnd = finalized ? pool.finalizedC : pool.headC;
    const nEnd = finalized ? pool.finalizedN : pool.headN;
    return {
      ok: true,
      json: async () => ({
        root: finalized ? 'root@finalized' : 'root@head',
        commitments_and_ciphertexts: pool.commitments.slice(offC, cEnd),
        nullifiers: pool.nullifiers.slice(offN, nEnd),
      }),
    };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
};

const makeAdapter = () => ({
  getSaplingDiffByContract: vi.fn(async (contract: string, block: unknown) => ({
    sentinel: 'adapter-contract',
    contract,
    block,
  })),
  getSaplingDiffById: vi.fn(async (query: unknown, block: unknown) => ({
    sentinel: 'adapter-id',
    query,
    block,
  })),
  someOtherMethod: () => 'other',
});

// Make backoff instant (and record the requested delays) so retry tests don't actually sleep.
let timerDelays: number[] = [];
beforeEach(() => {
  timerDelays = [];
  vi.stubGlobal('setTimeout', (fn: () => void, ms?: number) => {
    timerDelays.push(ms ?? 0);
    fn();
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('incremental sapling-diff cache', () => {
  it('cold read reconstructs the full head diff and persists ONLY the finalized prefix', async () => {
    const store = new MemoryDiffStore();
    const pool = makePool();
    const calls: string[] = [];
    installFetch(pool, calls);
    const provider = makeCachingReadProvider(makeAdapter(), RPC, store) as {
      getSaplingDiffByContract: (c: string, b?: unknown) => Promise<{
        root: string;
        commitments_and_ciphertexts: string[];
        nullifiers: string[];
      }>;
    };

    const cold = await provider.getSaplingDiffByContract(SET, 'head');

    // Reconstructed diff equals a full fetch at head (0..headC / 0..headN), with the head root.
    expect(cold.commitments_and_ciphertexts).toEqual(pool.commitments.slice(0, 7));
    expect(cold.nullifiers).toEqual(pool.nullifiers.slice(0, 4));
    expect(cold.root).toBe('root@head');

    // Persisted state is the FINALIZED prefix only (5 commitments / 3 nullifiers) — the 2/1
    // unconfirmed tail entries are NOT persisted (reorg safety).
    const cached = store.get(KEY) as CachedSaplingDiff;
    expect(cached.offC).toBe(5);
    expect(cached.offN).toBe(3);
    expect(cached.commitments).toEqual(pool.commitments.slice(0, 5));
  });

  it('warm read fetches only the delta and still reconstructs the full head diff', async () => {
    const store = new MemoryDiffStore();
    const pool = makePool();
    const calls: string[] = [];
    installFetch(pool, calls);
    const provider = makeCachingReadProvider(makeAdapter(), RPC, store) as {
      getSaplingDiffByContract: (c: string, b?: unknown) => Promise<{
        commitments_and_ciphertexts: string[];
        nullifiers: string[];
      }>;
    };

    await provider.getSaplingDiffByContract(SET, 'head'); // cold → cache offC=5

    // Pool advances: the 2 unconfirmed commitments finalize, 2 brand-new ones appear.
    pool.finalizedC = 7;
    pool.finalizedN = 4;
    pool.headC = 9;
    pool.headN = 5;
    calls.length = 0;

    const warm = await provider.getSaplingDiffByContract(SET, 'head');

    expect(warm.commitments_and_ciphertexts).toEqual(pool.commitments.slice(0, 9));
    expect(warm.nullifiers).toEqual(pool.nullifiers.slice(0, 5));

    // The finalized fetch used the cached offset (5), i.e. it requested only the delta.
    const finalizedCall = calls.find((u) => u.includes('head~2'))!;
    expect(finalizedCall).toContain('offset_commitment=5');
    expect(finalizedCall).toContain('offset_nullifier=3');
    // Cache advanced to the new finalized count (7), tail (2) still not persisted.
    expect((store.get(KEY) as CachedSaplingDiff).offC).toBe(7);
  });

  it('delegates non-head reads, falls back to the adapter on fetch error, and passes other members through', async () => {
    const store = new MemoryDiffStore();
    const pool = makePool();
    const calls: string[] = [];
    installFetch(pool, calls);
    const adapter = makeAdapter();
    const provider = makeCachingReadProvider(adapter, RPC, store) as unknown as {
      getSaplingDiffByContract: (c: string, b?: unknown) => Promise<{ sentinel?: string }>;
      getSaplingDiffById: (q: unknown, b?: unknown) => Promise<{ commitments_and_ciphertexts: string[] }>;
      someOtherMethod: () => string;
    };

    // Non-head block → delegate to the real adapter.
    const historical = await provider.getSaplingDiffByContract(SET, 'BMhistorical');
    expect(historical.sentinel).toBe('adapter-contract');
    expect(adapter.getSaplingDiffByContract).toHaveBeenCalled();

    // Fetch error on a head read → fall back to the adapter (never throw, never wrong).
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const fell = await provider.getSaplingDiffByContract(SET, 'head');
    expect(fell.sentinel).toBe('adapter-contract');

    // getSaplingDiffById head path reconstructs too (separate cache key).
    installFetch(pool, calls);
    const byId = await provider.getSaplingDiffById({ id: '5' }, 'head');
    expect(byId.commitments_and_ciphertexts).toEqual(pool.commitments.slice(0, 7));

    // Non-intercepted members pass through unchanged.
    expect(provider.someOtherMethod()).toBe('other');
  });

  it('retries a 429 with backoff and then succeeds (no error reaches the caller)', async () => {
    const store = new MemoryDiffStore();
    const pool = makePool();
    const fetchFn = installFlakyFetch(pool, 2); // first 2 calls 429, then serve normally
    const provider = makeCachingReadProvider(makeAdapter(), RPC, store) as {
      getSaplingDiffByContract: (c: string, b?: unknown) => Promise<{
        commitments_and_ciphertexts: string[];
        nullifiers: string[];
        root: string;
      }>;
    };

    const cold = await provider.getSaplingDiffByContract(SET, 'head');

    // Rate-limited twice, retried, then reconstructed correctly — the caller never sees an error.
    expect(cold.commitments_and_ciphertexts).toEqual(pool.commitments.slice(0, 7));
    expect(cold.root).toBe('root@head');
    // 2 × 429 (finalized) + finalized-ok + tail-ok = 4 calls; 2 backoffs awaited.
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(timerDelays.length).toBe(2);
  });

  it('honors the Retry-After header for the backoff delay', async () => {
    const store = new MemoryDiffStore();
    const pool = makePool();
    installFlakyFetch(pool, 1, 429, '2'); // one 429 carrying Retry-After: 2 (seconds)
    const provider = makeCachingReadProvider(makeAdapter(), RPC, store) as {
      getSaplingDiffByContract: (c: string, b?: unknown) => Promise<unknown>;
    };

    await provider.getSaplingDiffByContract(SET, 'head');

    // The retry waited the server-instructed 2s (2000ms), not the default exponential backoff.
    expect(timerDelays).toContain(2000);
  });

  it('gives up after the attempt cap and falls back to the adapter (never a wrong result)', async () => {
    const store = new MemoryDiffStore();
    const pool = makePool();
    const fetchFn = installFlakyFetch(pool, Infinity); // always 429
    const adapter = makeAdapter();
    const provider = makeCachingReadProvider(adapter, RPC, store) as unknown as {
      getSaplingDiffByContract: (c: string, b?: unknown) => Promise<{ sentinel?: string }>;
    };

    const fell = await provider.getSaplingDiffByContract(SET, 'head');

    // 4 bounded attempts on the finalized fetch, all 429 → throw → fall back to the adapter.
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fell.sentinel).toBe('adapter-contract');
  });

  it('does NOT retry a non-retryable status (404) — fails fast, then falls back', async () => {
    const store = new MemoryDiffStore();
    const pool = makePool();
    const fetchFn = installFlakyFetch(pool, Infinity, 404); // client error, not retryable
    const adapter = makeAdapter();
    const provider = makeCachingReadProvider(adapter, RPC, store) as unknown as {
      getSaplingDiffByContract: (c: string, b?: unknown) => Promise<{ sentinel?: string }>;
    };

    const fell = await provider.getSaplingDiffByContract(SET, 'head');

    // Exactly one attempt (no retry on 404) → fall back to the adapter.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fell.sentinel).toBe('adapter-contract');
  });
});
