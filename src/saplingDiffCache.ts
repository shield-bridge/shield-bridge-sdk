/* eslint-disable max-classes-per-file -- two small, closely-related store impls (memory + IndexedDB) belong together */
/**
 * Incremental sapling-diff cache (the FETCH layer).
 *
 * octez.js's SaplingTransactionViewer re-fetches a pool's ENTIRE `single_sapling_get_diff`
 * on every balance/transaction read (O(pool size), no offset, no cache). A pool's diff only
 * ever grows (commitment/nullifier trees are append-only), so this cost climbs without bound
 * and is paid on every scan, for every account, for every asset viewed.
 *
 * This module makes that fetch incremental WITHOUT touching the audited decrypt/spend logic:
 * a caching read-provider wraps the real RPC adapter and reconstructs the head diff from a
 * persisted FINALIZED prefix plus a freshly-fetched UNCONFIRMED tail. The viewer still runs
 * its normal `getBalance()` over the (identical) reconstructed diff, so there is zero risk of
 * a wrong balance — the only thing that changes is how many bytes cross the wire.
 *
 *   today:       get_diff(head)                      → 525 KB every scan (XTZ pool, and growing)
 *   incremental: get_diff(head~2, offset=cached)     → ~125 B when nothing finalized since last
 *              + get_diff(head,   offset=finalized)  → only the unconfirmed tail (≤2 blocks)
 *
 * Cached data is PUBLIC pool state (encrypted commitments + nullifiers) keyed by
 * `(rpc host, set contract / sapling id)` — account-agnostic, so it is shared across every
 * shielded account on the device and carries no decrypted/private material.
 *
 * Reorg safety: Tezos (Tenderbake) finalizes a block after 2 confirmations, so the diff at
 * `head~2` is immutable — safe to persist. The unconfirmed tail (`head~2`..`head`) is fetched
 * fresh every scan and NEVER persisted, so a reorg of a recent block self-heals on the next
 * scan, and an account's own just-submitted note still shows immediately (it's in the tail).
 *
 * Foolproof by construction: any error (offset unsupported, short chain, store failure, …)
 * falls back to the wrapped adapter's full fetch — never a wrong or missing result.
 */

/** The shape octez.js's get_diff RPC returns (snake_case, passed through verbatim). */
export interface SaplingDiffResponse {
  root: string;
  commitments_and_ciphertexts: unknown[];
  nullifiers: unknown[];
}

/** Persisted FINALIZED state for one pool. Public data only. */
export interface CachedSaplingDiff {
  /** count of finalized commitments cached (the next offset_commitment to fetch from) */
  offC: number;
  /** count of finalized nullifiers cached (the next offset_nullifier to fetch from) */
  offN: number;
  commitments: unknown[];
  nullifiers: unknown[];
}

/**
 * Pluggable persistent store for the diff cache. The browser uses an IndexedDB-backed
 * implementation automatically; Node/Lambda/tests can inject {@link MemoryDiffStore} or a
 * custom store. Methods may be sync or async.
 */
export interface SaplingDiffStore {
  // Values are `unknown`: one store backs both the public diff cache (CachedSaplingDiff) and the
  // per-account balance cache (CachedAccountBalance), under non-colliding key prefixes.
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  /** Optional: delete every key with the given prefix (used to evict an account's balance cache). */
  deleteByPrefix?(prefix: string): Promise<void> | void;
}

/** Tenderbake finality: a block is final after this many confirmations. */
const CONFIRMATIONS = 2;

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** In-memory store (process lifetime). For Node/Lambda/tests; browsers should use IndexedDB. */
export class MemoryDiffStore implements SaplingDiffStore {
  private readonly map = new Map<string, unknown>();

  get(key: string): unknown {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .forEach((k) => this.map.delete(k));
  }
}

/** IndexedDB-backed store — works on the main thread AND inside Web Workers (same origin DB). */
export class IndexedDbDiffStore implements SaplingDiffStore {
  private readonly dbName = 'shield-bridge-sapling-cache';

  private readonly storeName = 'diffs';

  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async get(key: string): Promise<unknown> {
    const db = await this.open();
    return new Promise<unknown>((resolve, reject) => {
      const req = db
        .transaction(this.storeName, 'readonly')
        .objectStore(this.storeName)
        .get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async set(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const req = db
        .transaction(this.storeName, 'readwrite')
        .objectStore(this.storeName)
        .put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const req = db
        .transaction(this.storeName, 'readwrite')
        .objectStore(this.storeName)
        .delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const objectStore = db
        .transaction(this.storeName, 'readwrite')
        .objectStore(this.storeName);
      const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
      const req = objectStore.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  }
}

function indexedDbAvailable(): boolean {
  try {
    // eslint-disable-next-line no-restricted-globals
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** The default store for the current runtime: IndexedDB if available (browser / web worker), else none. */
export function createDefaultDiffStore(): SaplingDiffStore | null {
  return indexedDbAvailable() ? new IndexedDbDiffStore() : null;
}

// ---------------------------------------------------------------------------
// Incremental fetch
// ---------------------------------------------------------------------------

export type DiffTarget = { kind: 'contract' | 'id'; id: string };

function hostOf(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}

function cacheKey(rpcUrl: string, target: DiffTarget): string {
  return `${hostOf(rpcUrl)}|${target.kind}:${target.id}`;
}

/** Raw offset get_diff — octez.js's client never passes offsets, so build the URL directly. */
async function fetchDiffAtOffset(
  rpcUrl: string,
  target: DiffTarget,
  block: string,
  offC: number,
  offN: number,
): Promise<SaplingDiffResponse> {
  const base = rpcUrl.replace(/\/+$/, '');
  const path =
    target.kind === 'contract'
      ? `/chains/main/blocks/${block}/context/contracts/${target.id}/single_sapling_get_diff`
      : `/chains/main/blocks/${block}/context/sapling/${target.id}/get_diff`;
  const url = `${base}${path}?offset_commitment=${offC}&offset_nullifier=${offN}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`get_diff ${res.status} ${res.statusText} for ${block}`);
  }
  return (await res.json()) as SaplingDiffResponse;
}

/**
 * A pool's diff at head, split into the immutable FINALIZED prefix (head~2, persisted) and the
 * UNCONFIRMED tail (head~2..head, never persisted). `finalized*` are the FULL finalized arrays
 * (indices 0..finalizedCount); the tail arrays continue from there. Positions are absolute and
 * stable (commitment/nullifier trees are append-only), which is what lets a decrypted-note
 * cache key off the position.
 */
export interface PoolDiffSplit {
  root: string;
  finalizedCommitments: unknown[];
  finalizedNullifiers: unknown[];
  tailCommitments: unknown[];
  tailNullifiers: unknown[];
}

/**
 * Sync a pool's diff incrementally: extend the persisted finalized prefix by its offset, then
 * fetch the fresh unconfirmed tail. Persists ONLY the finalized prefix. The finalized fetch
 * transfers ~nothing in steady state; the tail is ≤2 blocks. This is the shared core used both
 * by the v1 read-provider (which merges the two) and the v2 balance cache (which needs them
 * separately so it can persist decrypted notes for the finalized prefix only).
 */
export async function syncPoolDiff(
  store: SaplingDiffStore,
  rpcUrl: string,
  target: DiffTarget,
): Promise<PoolDiffSplit> {
  const key = cacheKey(rpcUrl, target);
  const cached: CachedSaplingDiff = ((await store.get(
    key,
  )) as CachedSaplingDiff | null) ?? {
    offC: 0,
    offN: 0,
    commitments: [],
    nullifiers: [],
  };

  // 1. Extend the FINALIZED prefix. head~2 is immutable under Tenderbake finality, so this can
  //    be persisted and never rolled back. In steady state this returns ~nothing.
  const fin = await fetchDiffAtOffset(
    rpcUrl,
    target,
    `head~${CONFIRMATIONS}`,
    cached.offC,
    cached.offN,
  );
  const finalizedCommitments = cached.commitments.concat(
    fin.commitments_and_ciphertexts,
  );
  const finalizedNullifiers = cached.nullifiers.concat(fin.nullifiers);
  await store.set(key, {
    offC: finalizedCommitments.length,
    offN: finalizedNullifiers.length,
    commitments: finalizedCommitments,
    nullifiers: finalizedNullifiers,
  });

  // 2. Fetch the UNCONFIRMED tail (head~2..head). NEVER persisted: a reorg of these blocks
  //    self-heals on the next scan, and the account's own just-submitted note is here, so it
  //    shows immediately.
  const tail = await fetchDiffAtOffset(
    rpcUrl,
    target,
    'head',
    finalizedCommitments.length,
    finalizedNullifiers.length,
  );
  return {
    root: tail.root,
    finalizedCommitments,
    finalizedNullifiers,
    tailCommitments: tail.commitments_and_ciphertexts,
    tailNullifiers: tail.nullifiers,
  };
}

/** v1 helper: the full head diff (finalized + tail merged) — identical to a full get_diff(head). */
async function incrementalDiff(
  store: SaplingDiffStore,
  rpcUrl: string,
  target: DiffTarget,
): Promise<SaplingDiffResponse> {
  const s = await syncPoolDiff(store, rpcUrl, target);
  return {
    root: s.root,
    commitments_and_ciphertexts: s.finalizedCommitments.concat(
      s.tailCommitments,
    ),
    nullifiers: s.finalizedNullifiers.concat(s.tailNullifiers),
  };
}

// ---------------------------------------------------------------------------
// Caching read provider
// ---------------------------------------------------------------------------

/**
 * Wrap an octez.js read provider so the viewer's `get_diff` calls at `head` are served
 * incrementally. Every other provider method, and any non-`head` block read, delegates to the
 * real adapter unchanged. Any failure in the incremental path also delegates (full fetch), so
 * the wrapper can only ever make reads cheaper — never wrong, never failed.
 */
export function makeCachingReadProvider<T extends object>(
  adapter: T,
  rpcUrl: string,
  store: SaplingDiffStore,
): T {
  const isHead = (block: unknown): boolean =>
    block === 'head' || block === undefined;

  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'getSaplingDiffByContract') {
        return async (contract: string, block?: unknown) => {
          if (isHead(block)) {
            try {
              return await incrementalDiff(store, rpcUrl, {
                kind: 'contract',
                id: contract,
              });
            } catch {
              /* fall through to a full fetch — foolproof */
            }
          }
          return (
            target as Record<string, (...a: unknown[]) => unknown>
          ).getSaplingDiffByContract.call(target, contract, block);
        };
      }
      if (prop === 'getSaplingDiffById') {
        return async (query: unknown, block?: unknown) => {
          if (isHead(block)) {
            try {
              const id = String((query as { id?: unknown })?.id ?? query);
              return await incrementalDiff(store, rpcUrl, { kind: 'id', id });
            } catch {
              /* fall through */
            }
          }
          return (
            target as Record<string, (...a: unknown[]) => unknown>
          ).getSaplingDiffById.call(target, query, block);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}
