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
  get(
    key: string,
  ): Promise<CachedSaplingDiff | null> | CachedSaplingDiff | null;
  set(key: string, value: CachedSaplingDiff): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

/** Tenderbake finality: a block is final after this many confirmations. */
const CONFIRMATIONS = 2;

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** In-memory store (process lifetime). For Node/Lambda/tests; browsers should use IndexedDB. */
export class MemoryDiffStore implements SaplingDiffStore {
  private readonly map = new Map<string, CachedSaplingDiff>();

  get(key: string): CachedSaplingDiff | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, value: CachedSaplingDiff): void {
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
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

  async get(key: string): Promise<CachedSaplingDiff | null> {
    const db = await this.open();
    return new Promise<CachedSaplingDiff | null>((resolve, reject) => {
      const req = db
        .transaction(this.storeName, 'readonly')
        .objectStore(this.storeName)
        .get(key);
      req.onsuccess = () => resolve((req.result as CachedSaplingDiff) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async set(key: string, value: CachedSaplingDiff): Promise<void> {
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

type DiffTarget = { kind: 'contract' | 'id'; id: string };

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
 * Reconstruct the head diff incrementally: extend the persisted finalized prefix (head~2) by
 * its offset, then append the freshly-fetched unconfirmed tail (head). Returns a diff that is
 * identical to a full `get_diff(head)`, but typically transfers only a few hundred bytes.
 */
async function incrementalDiff(
  store: SaplingDiffStore,
  rpcUrl: string,
  target: DiffTarget,
): Promise<SaplingDiffResponse> {
  const key = cacheKey(rpcUrl, target);
  const cached: CachedSaplingDiff = (await store.get(key)) ?? {
    offC: 0,
    offN: 0,
    commitments: [],
    nullifiers: [],
  };

  // 1. Extend the FINALIZED prefix. head~2 is immutable under Tenderbake finality, so this
  //    can be persisted and never rolled back. In steady state this returns ~nothing.
  const fin = await fetchDiffAtOffset(
    rpcUrl,
    target,
    `head~${CONFIRMATIONS}`,
    cached.offC,
    cached.offN,
  );
  const commitments = cached.commitments.concat(
    fin.commitments_and_ciphertexts,
  );
  const nullifiers = cached.nullifiers.concat(fin.nullifiers);
  const finalized: CachedSaplingDiff = {
    offC: commitments.length,
    offN: nullifiers.length,
    commitments,
    nullifiers,
  };
  await store.set(key, finalized);

  // 2. Append the UNCONFIRMED tail (head~2..head). NEVER persisted: a reorg of these blocks
  //    self-heals on the next scan, and the account's own just-submitted note is here, so it
  //    shows immediately. The head root is the current one the viewer should see.
  const tail = await fetchDiffAtOffset(
    rpcUrl,
    target,
    'head',
    finalized.offC,
    finalized.offN,
  );
  return {
    root: tail.root,
    commitments_and_ciphertexts: commitments.concat(
      tail.commitments_and_ciphertexts,
    ),
    nullifiers: nullifiers.concat(tail.nullifiers),
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
