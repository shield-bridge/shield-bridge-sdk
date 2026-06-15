/**
 * Unit tests for the incremental BALANCE cache (saplingBalanceCache.ts) — the v2 decrypt layer.
 *
 * Network-free: a mocked `fetch` serves a synthetic append-only pool's get_diff at head~2
 * (finalized) and head (current), and a mock viewer stands in for octez.js's
 * SaplingTransactionViewer (decrypt / isSpent / getBalance). Each test uses a UNIQUE viewing-key
 * fingerprint so the module-level self-check counter starts fresh.
 *
 * Covers: cold == stock + cache populated; decrypt-only-new on a warm scan; finalized spent
 * transition (persisted); tail-spent overlay (NOT persisted → reorg self-heals); and the
 * self-check catching a divergence and falling back to the stock balance.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { MemoryDiffStore } from '../src/saplingDiffCache';
import { incrementalBalance, viewingKeyFingerprint } from '../src/saplingBalanceCache';

const RPC = 'https://rpc.example/mainnet';
const SET = 'KT1BalSet';

type Commitment = { mine: boolean; value: number };

type Pool = {
  commitments: Commitment[];
  finalizedC: number;
  headC: number;
  nullifiersFinalized: string[]; // `null-<pos>` for finalized spends
  nullifiersTail: string[]; // `null-<pos>` for unconfirmed spends
};

const makePool = (): Pool => ({
  // mine at positions 1,3,5,7 with values 10,20,5,100
  commitments: [
    { mine: false, value: 0 },
    { mine: true, value: 10 },
    { mine: false, value: 0 },
    { mine: true, value: 20 },
    { mine: false, value: 0 },
    { mine: true, value: 5 },
    { mine: false, value: 0 },
    { mine: true, value: 100 },
    { mine: false, value: 0 },
  ],
  finalizedC: 5, // finalized commitments 0..4
  headC: 7, // head commitments 0..6 (tail = 5,6)
  nullifiersFinalized: [],
  nullifiersTail: [],
});

const headNullifiers = (pool: Pool): string[] =>
  pool.nullifiersFinalized.concat(pool.nullifiersTail);

const installFetch = (pool: Pool) => {
  const fn = vi.fn(async (url: string) => {
    const u = new URL(url);
    const finalized = url.includes('head~2');
    const offC = Number(u.searchParams.get('offset_commitment') ?? 0);
    const offN = Number(u.searchParams.get('offset_nullifier') ?? 0);
    const commitments = finalized
      ? pool.commitments.slice(offC, pool.finalizedC)
      : pool.commitments.slice(offC, pool.headC);
    const nullifiers = finalized
      ? pool.nullifiersFinalized.slice(offN)
      : headNullifiers(pool).slice(offN);
    return {
      ok: true,
      json: async () => ({ root: finalized ? 'r@fin' : 'r@head', commitments_and_ciphertexts: commitments, nullifiers }),
    };
  });
  vi.stubGlobal('fetch', fn);
};

// Mock viewer: decrypt returns a note for "mine" commitments (value as a 1-byte buffer so
// toValue() recovers it); isSpent matches a per-position marker; getBalance is the stock truth.
const makeViewer = (pool: Pool, getBalanceOverride?: () => BigNumber | null) => {
  const decryptedPositions: number[] = [];
  // commitments passed to decrypt carry no position, so we tag them by identity → index.
  const indexOf = new Map<Commitment, number>();
  pool.commitments.forEach((c, i) => indexOf.set(c, i));
  const viewer = {
    decryptCiphertextAsReceiver: vi.fn(async (commitment: Commitment) => {
      const pos = indexOf.get(commitment);
      if (pos !== undefined) decryptedPositions.push(pos);
      if (!commitment.mine) return undefined;
      return {
        value: Buffer.from([commitment.value]),
        paymentAddress: Buffer.from([(pos ?? 0) & 0xff]),
        randomCommitmentTrapdoor: Buffer.from([1]),
      };
    }),
    isSpent: vi.fn(async (_addr: unknown, _val: string, _rcm: unknown, position: number, nullifiers: unknown[]) =>
      (nullifiers as string[]).includes(`null-${position}`),
    ),
    getBalance: vi.fn(async () => {
      const o = getBalanceOverride?.();
      if (o != null) return o;
      const spent = headNullifiers(pool);
      let bal = new BigNumber(0);
      for (let i = 0; i < pool.headC; i += 1) {
        const c = pool.commitments[i];
        if (c.mine && !spent.includes(`null-${i}`)) bal = bal.plus(c.value);
      }
      return bal;
    }),
  };
  return { viewer, decryptedPositions };
};

const balKey = (fvk: string) =>
  `bal:${viewingKeyFingerprint(fvk)}:rpc.example:contract:${SET}`;

const run = (store: MemoryDiffStore, viewer: unknown, fvkHex: string, selfCheckEvery?: number) =>
  incrementalBalance({
    store,
    rpcUrl: RPC,
    target: { kind: 'contract', id: SET },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewer: viewer as any,
    fvkHex,
    selfCheckEvery,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('incremental balance cache', () => {
  it('cold build equals the stock balance and populates the per-account cache', async () => {
    const pool = makePool();
    installFetch(pool);
    const store = new MemoryDiffStore();
    const { viewer } = makeViewer(pool);
    const fvk = 'fvk-cold';

    const balance = await run(store, viewer, fvk);

    // mine: 10 (pos1, finalized) + 20 (pos3, finalized) + 5 (pos5, tail) = 35
    expect(balance.toString()).toBe('35');
    expect((await viewer.getBalance()).toString()).toBe('35');

    const cached = store.get(balKey(fvk)) as { decryptCursor: number; notes: unknown[] };
    expect(cached.decryptCursor).toBe(5); // finalized count
    expect(cached.notes.length).toBe(2); // positions 1,3 (tail note 5 is NOT persisted)
  });

  it('warm scan decrypts only NEW commitments', async () => {
    const pool = makePool();
    installFetch(pool);
    const store = new MemoryDiffStore();
    const { viewer, decryptedPositions } = makeViewer(pool);
    const fvk = 'fvk-warm';

    await run(store, viewer, fvk); // cold: decrypts finalized 0..4 + tail 5..6
    decryptedPositions.length = 0; // reset the recorder

    // pool advances: 5,6 finalize; tail now 7,8 (mine 7 = 100)
    pool.finalizedC = 7;
    pool.headC = 9;

    const balance = await run(store, viewer, fvk);

    // Decrypted ONLY the new commitments (finalized 5,6 + tail 7,8) — never re-decrypted 0..4.
    expect(decryptedPositions.sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
    // 10 + 20 + 5 (now finalized) + 100 (tail) = 135
    expect(balance.toString()).toBe('135');
  });

  it('persists a FINALIZED spent transition (note drops out and stays out)', async () => {
    const pool = makePool();
    installFetch(pool);
    const store = new MemoryDiffStore();
    const { viewer } = makeViewer(pool);
    const fvk = 'fvk-spent-final';

    await run(store, viewer, fvk); // balance 35, notes 1 & 3 unspent

    // A finalized spend of position 1 (value 10) appears.
    pool.nullifiersFinalized.push('null-1');
    const balance = await run(store, viewer, fvk);

    expect(balance.toString()).toBe('25'); // 20 (pos3) + 5 (pos5 tail); pos1 spent
    const cached = store.get(balKey(fvk)) as { notes: Array<{ position: number; spent: boolean }> };
    const note1 = cached.notes.find((n) => n.position === 1)!;
    expect(note1.spent).toBe(true); // persisted
  });

  it('applies a TAIL-spent overlay WITHOUT persisting it (reorg self-heals)', async () => {
    const pool = makePool();
    installFetch(pool);
    const store = new MemoryDiffStore();
    const { viewer } = makeViewer(pool);
    const fvk = 'fvk-spent-tail';

    await run(store, viewer, fvk); // balance 35

    // An UNCONFIRMED spend of position 3 (value 20) appears in the tail only.
    pool.nullifiersTail.push('null-3');
    const duringSpend = await run(store, viewer, fvk);
    expect(duringSpend.toString()).toBe('15'); // 10 (pos1) + 5 (pos5); pos3 excluded this scan
    // ...but NOT persisted as spent.
    const cached = store.get(balKey(fvk)) as { notes: Array<{ position: number; spent: boolean }> };
    expect(cached.notes.find((n) => n.position === 3)!.spent).toBe(false);

    // The tail reorgs the spend away → pos3 returns to the balance.
    pool.nullifiersTail = [];
    const afterReorg = await run(store, viewer, fvk);
    expect(afterReorg.toString()).toBe('35');
  });

  it('self-check (warm scan) catches a divergence, invalidates the cache, and returns the stock balance', async () => {
    const pool = makePool();
    installFetch(pool);
    const store = new MemoryDiffStore();
    // `lie` flips stock to a wrong value, simulating the incremental computation diverging.
    let lie = false;
    const { viewer } = makeViewer(pool, () => (lie ? new BigNumber(999) : null));
    const fvk = 'fvk-selfcheck';

    const cold = await run(store, viewer, fvk, 1); // cold build (no self-check); correct = 35
    expect(cold.toString()).toBe('35');

    lie = true; // now the (warm) self-check will see a mismatch
    const warm = await run(store, viewer, fvk, 1); // self-check every scan

    expect(warm.toString()).toBe('999'); // trusted stock value returned
    expect(store.get(balKey(fvk))).toBeNull(); // cache invalidated
  });
});
