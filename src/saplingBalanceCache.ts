/**
 * Incremental shielded-balance cache (the DECRYPT layer — "v2").
 *
 * v1 (saplingDiffCache) made the FETCH incremental but the viewer still trial-decrypts EVERY
 * commitment and re-checks EVERY matched note's spent status on each read (O(pool size)). This
 * layer makes the DECRYPT incremental too: it caches the account's matched notes and only
 * decrypts commitments added since the last scan, then re-checks spent status using octez.js's
 * own `isSpent` (no nullifier re-implementation — the audited logic is reused verbatim).
 *
 * Safety model (this is a money path, so it is deliberately conservative):
 *  - PER-ACCOUNT + private: the cache holds DECRYPTED notes, so it is keyed by a non-reversible
 *    fingerprint of the viewing key. Evict on account forget (clearForViewingKey).
 *  - Reorg-safe: decrypted notes are persisted ONLY for the finalized prefix (head~2, immutable
 *    under Tenderbake). The unconfirmed tail is decrypted fresh every scan and never persisted;
 *    a spent flag is persisted only when caused by a FINALIZED nullifier. So a reorg of a recent
 *    block self-heals, and a just-received note shows immediately.
 *  - Self-checking: every Nth scan (and on every cold build) the incremental result is compared
 *    against a full stock `getBalance()`. Any mismatch invalidates the cache, returns the stock
 *    value, and warns — so a bug here can never silently surface a wrong balance for long.
 *  - Foolproof: any thrown error falls back to the full stock `getBalance()`.
 */
/* eslint-disable no-await-in-loop, no-restricted-syntax, no-continue, no-bitwise --
   The decrypt and isSpent loops are SEQUENTIAL BY DESIGN: each calls the single-threaded sapling
   wasm, and octez.js's own getBalance() iterates them serially. Parallelizing (Promise.all) would
   make re-entrant wasm calls. The loops are bounded by the account's matched-note count (not the
   pool size), so this stays incremental. */
import BigNumber from 'bignumber.js';
import { secretBox, openSecretBox } from '@stablelib/nacl';
import { randomBytes } from '@stablelib/random';
import { blake2b } from 'blakejs';
import {
  syncPoolDiff,
  type SaplingDiffStore,
  type DiffTarget,
} from './saplingDiffCache.js';

/** A matched, decrypted note in the FINALIZED prefix (the only notes we persist). */
interface CachedNote {
  position: number; // absolute commitment index (stable — trees are append-only)
  valueStr: string; // base-unit value as a decimal string
  addressHex: string; // payment address bytes, hex (re-passed to isSpent)
  rcmHex: string; // random commitment trapdoor bytes, hex
  spent: boolean; // FINALIZED-spent only (immutable once true)
}

interface CachedAccountBalance {
  decryptCursor: number; // # finalized commitments decrypted so far
  notes: CachedNote[];
}

/** The subset of octez.js's SaplingTransactionViewer this layer drives (runtime-accessible). */
export interface BalanceViewer {
  decryptCiphertextAsReceiver(commitmentAndCiphertext: unknown): Promise<
    | {
        value: unknown;
        paymentAddress: Uint8Array;
        randomCommitmentTrapdoor: unknown;
      }
    | undefined
  >;
  isSpent(
    address: unknown,
    value: string,
    randomCommitmentTrapdoor: unknown,
    position: number,
    nullifiers: unknown[],
  ): Promise<boolean>;
  getBalance(): Promise<BigNumber>;
}

const DEFAULT_SELF_CHECK_EVERY = 8;
const BAL_KEY_PREFIX = 'bal:';

// Per-account self-check cadence counter (module memory — controls sampling only, not correctness).
const selfCheckCounters = new Map<string, number>();

/** Mirrors octez.js's convertValueToBigNumber: the value bytes parsed as a base-16 integer. */
const toValue = (value: unknown): BigNumber =>
  new BigNumber(Buffer.from(value as Uint8Array).toString('hex'), 16);

const toHex = (bytes: unknown): string =>
  Buffer.from(bytes as Uint8Array).toString('hex');
const fromHex = (hex: string): Buffer => Buffer.from(hex, 'hex');

/** cyrb53: a fast, dependency-free, non-cryptographic 53-bit hash. Used only to namespace the
 *  cache by viewing key WITHOUT writing the (sensitive) viewing key into a storage key. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Stable fingerprint of a full viewing key — non-reversible, so it never exposes the key. */
export function viewingKeyFingerprint(fvkHex: string): string {
  return cyrb53(fvkHex);
}

function balanceKey(
  fvkHex: string,
  rpcUrl: string,
  target: DiffTarget,
): string {
  let host: string;
  try {
    host = new URL(rpcUrl).host;
  } catch {
    host = rpcUrl;
  }
  return `${BAL_KEY_PREFIX}${viewingKeyFingerprint(fvkHex)}:${host}:${target.kind}:${target.id}`;
}

// ---------------------------------------------------------------------------
// At-rest encryption
// ---------------------------------------------------------------------------
// Cached notes are decrypted balances, so they are NEVER written in the clear. Each entry is
// encrypted under a key derived from the viewing key (the same secret that already decrypts the
// notes on-chain), using XSalsa20-Poly1305 (authenticated) and a random nonce. All pure
// JS/wasm — no crypto.subtle — so it works in non-secure contexts (e.g. a LAN/HTTP origin)
// too. Effect: at rest the cache is opaque ciphertext only the viewing-key holder can read.
// A locked account (its viewing key encrypted behind the password) can't be read off disk; a
// session-only account leaves only undecryptable ciphertext once its key is gone. This is an
// AT-REST defense only — while the app is unlocked the key + balances are in memory as usual.

const CACHE_KEY_DOMAIN = Buffer.from('shield-bridge/balance-cache/v1');

interface EncryptedEnvelope {
  v: 1;
  n: string; // nonce (hex)
  c: string; // ciphertext (hex)
}

/** 32-byte symmetric key bound to the viewing key (domain-separated keyed blake2b). */
function deriveCacheKey(fvkHex: string): Uint8Array {
  return blake2b(Buffer.from(fvkHex, 'utf8'), CACHE_KEY_DOMAIN, 32);
}

function encryptAccount(
  acct: CachedAccountBalance,
  fvkHex: string,
): EncryptedEnvelope {
  const key = deriveCacheKey(fvkHex);
  const nonce = randomBytes(24);
  const box = secretBox(key, nonce, Buffer.from(JSON.stringify(acct), 'utf8'));
  return {
    v: 1,
    n: Buffer.from(nonce).toString('hex'),
    c: Buffer.from(box).toString('hex'),
  };
}

/** Decrypt a stored envelope, or return null (→ rebuild) on a wrong key, tamper, or bad shape.
 *  Exported for inspection/tests; the SDK package does not re-export it. */
export function decryptAccount(
  stored: unknown,
  fvkHex: string,
): CachedAccountBalance | null {
  const env = stored as Partial<EncryptedEnvelope> | null;
  if (
    !env ||
    env.v !== 1 ||
    typeof env.n !== 'string' ||
    typeof env.c !== 'string'
  )
    return null;
  const opened = openSecretBox(
    deriveCacheKey(fvkHex),
    Buffer.from(env.n, 'hex'),
    Buffer.from(env.c, 'hex'),
  );
  if (!opened) return null; // wrong key / tampered / different account → treat as a cache miss
  try {
    return JSON.parse(
      Buffer.from(opened).toString('utf8'),
    ) as CachedAccountBalance;
  } catch {
    return null;
  }
}

/**
 * Incremental shielded balance (base units). Falls back to a full stock `getBalance()` on any
 * error. The same `store` backs v1's diff cache (namespaced keys never collide).
 */
export async function incrementalBalance(opts: {
  store: SaplingDiffStore;
  rpcUrl: string;
  target: DiffTarget;
  viewer: BalanceViewer;
  fvkHex: string;
  selfCheckEvery?: number;
}): Promise<BigNumber> {
  const { store, rpcUrl, target, viewer, fvkHex } = opts;
  const everyN = opts.selfCheckEvery ?? DEFAULT_SELF_CHECK_EVERY;
  const key = balanceKey(fvkHex, rpcUrl, target);

  try {
    // 1. Incremental fetch → finalized prefix (persisted by v1) + fresh unconfirmed tail.
    const split = await syncPoolDiff(store, rpcUrl, target);
    const finalizedCount = split.finalizedCommitments.length;

    // 2. Load + decrypt the per-account note cache; reset if it's somehow ahead of the chain
    //    (append-only means this can't legitimately happen — defensive). A failed decrypt
    //    (wrong key / tamper) yields null here and rebuilds from scratch.
    const loaded = decryptAccount(await store.get(key), fvkHex);
    let acct: CachedAccountBalance =
      loaded &&
      Array.isArray(loaded.notes) &&
      typeof loaded.decryptCursor === 'number'
        ? loaded
        : { decryptCursor: 0, notes: [] };
    if (acct.decryptCursor > finalizedCount)
      acct = { decryptCursor: 0, notes: [] };
    const priorCursor = acct.decryptCursor; // 0 ⇒ this is a cold full build

    // 3. Decrypt ONLY new finalized commitments; cache the matches.
    for (let i = acct.decryptCursor; i < finalizedCount; i += 1) {
      const d = await viewer.decryptCiphertextAsReceiver(
        split.finalizedCommitments[i],
      );
      if (d) {
        acct.notes.push({
          position: i,
          valueStr: toValue(d.value).toString(),
          addressHex: toHex(d.paymentAddress),
          rcmHex: toHex(d.randomCommitmentTrapdoor),
          spent: false,
        });
      }
    }
    acct.decryptCursor = finalizedCount;

    // 4. Finalized spent transitions (immutable → persisted): re-check unspent notes against the
    //    finalized nullifier set only.
    for (const n of acct.notes) {
      if (!n.spent) {
        const spent = await viewer.isSpent(
          fromHex(n.addressHex),
          n.valueStr,
          fromHex(n.rcmHex),
          n.position,
          split.finalizedNullifiers,
        );
        if (spent) n.spent = true;
      }
    }
    await store.set(key, encryptAccount(acct, fvkHex));

    // 5. Balance from finalized notes, applying a NON-persisted tail-spent overlay (a note spent
    //    only in the unconfirmed tail is excluded this scan but not marked spent on disk).
    let balance = new BigNumber(0);
    const hasTailNullifiers = split.tailNullifiers.length > 0;
    for (const n of acct.notes) {
      if (n.spent) continue;
      const tailSpent =
        hasTailNullifiers &&
        (await viewer.isSpent(
          fromHex(n.addressHex),
          n.valueStr,
          fromHex(n.rcmHex),
          n.position,
          split.tailNullifiers,
        ));
      if (!tailSpent) balance = balance.plus(new BigNumber(n.valueStr));
    }

    // 6. Tail notes: decrypt fresh (never persisted), add the unspent ones.
    const allNullifiers = split.finalizedNullifiers.concat(
      split.tailNullifiers,
    );
    for (let j = 0; j < split.tailCommitments.length; j += 1) {
      const d = await viewer.decryptCiphertextAsReceiver(
        split.tailCommitments[j],
      );
      if (!d) continue;
      const position = finalizedCount + j;
      const valueStr = toValue(d.value).toString();
      const spent = await viewer.isSpent(
        d.paymentAddress,
        valueStr,
        d.randomCommitmentTrapdoor,
        position,
        allNullifiers,
      );
      if (!spent) balance = balance.plus(new BigNumber(valueStr));
    }

    // 7. Self-check on WARM scans, sampled ~1/everyN. A cold full build (priorCursor === 0) is by
    //    construction a full scan equal to stock, so re-running getBalance there would only double
    //    the cold cost; the periodic warm check guards against incremental drift. Any mismatch ⇒ a
    //    bug here; invalidate the cache + return the trusted stock value.
    //
    //    The per-key counter is seeded with a RANDOM phase, not 0. This module's state lives in the
    //    worker, which is recreated on every page load — so a 0 seed made `count % everyN === 0`
    //    fire on the FIRST warm scan of EVERY asset each session: a synchronized stampede that
    //    re-fetched the diff AND forced a full stock re-decrypt (O(pool)) for the whole portfolio on
    //    every load — the very cost this cache exists to avoid. A random phase keeps the same
    //    long-run sampling rate while firing on any single scan (incl. the first) with prob ~1/everyN.
    let count = selfCheckCounters.get(key);
    if (count === undefined) count = Math.floor(Math.random() * everyN);
    selfCheckCounters.set(key, count + 1);
    if (priorCursor > 0 && count % everyN === 0) {
      const stock = await viewer.getBalance();
      if (!stock.eq(balance)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ShieldBridgeSDK] balance-cache self-check mismatch (incremental=${balance.toString()}, stock=${stock.toString()}); invalidating cache and using stock.`,
        );
        await store.delete(key);
        return stock;
      }
    }

    return balance;
  } catch (err) {
    // Foolproof: never let the optimization break or mis-report a balance.
    // eslint-disable-next-line no-console
    console.warn(
      '[ShieldBridgeSDK] balance cache failed; falling back to full scan:',
      err,
    );
    return viewer.getBalance();
  }
}

/** Evict every cached balance for a viewing key (call on account forget — removes decrypted data). */
export async function clearForViewingKey(
  store: SaplingDiffStore,
  fvkHex: string,
): Promise<void> {
  if (typeof store.deleteByPrefix === 'function') {
    await store.deleteByPrefix(
      `${BAL_KEY_PREFIX}${viewingKeyFingerprint(fvkHex)}:`,
    );
  }
}
