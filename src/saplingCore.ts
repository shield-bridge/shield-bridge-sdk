/**
 * Core sapling worker functions — no Comlink, no threading.
 *
 * This module contains all the sapling operations (key management, proof
 * generation, balance/transaction queries) without any Comlink or Web Worker
 * dependency.  It is the single source of truth that both:
 *
 * - `worker.ts` wraps with Comlink.expose() for browser Web Workers / Node.js
 *   worker_threads, and
 * - `index.ts` can import directly for thread-free ("direct execution") mode
 *   (e.g. AWS Lambda, CLI tools).
 *
 * The module maintains singleton state (spending key, toolkit, etc.) which is
 * safe because each execution context (Web Worker, worker_thread, or the main
 * thread in direct mode) loads its own copy.
 */

import { RpcReadAdapter } from '@tezos-x/octez.js';
import {
  SaplingToolkit,
  InMemorySpendingKey,
  InMemoryViewingKey,
  SaplingTransactionViewer,
} from '@tezos-x/octez.js-sapling';
import { RpcClient } from '@tezos-x/octez.js-rpc';
import { PrefixV2, b58Encode, bytesToString } from '@tezos-x/octez.js-utils';
import * as sapling from '@airgap/sapling-wasm';
import * as bip39 from 'bip39';
import BigNumber from 'bignumber.js';

import type {
  SaplingContractDetails,
  ParametersSaplingTransaction as TaquitoSaplingTxParams,
  ParametersUnshieldedTransaction as TaquitoUnshieldTxParams,
} from '@tezos-x/octez.js-sapling/dist/types/types';
import type {
  ParametersSaplingTransaction,
  ParametersUnshieldedTransaction,
} from './types.js';
import {
  makeCachingReadProvider,
  createDefaultDiffStore,
  type SaplingDiffStore,
  type DiffTarget,
} from './saplingDiffCache.js';
import {
  incrementalBalance,
  clearForViewingKey,
  type BalanceViewer,
} from './saplingBalanceCache.js';

// Re-export the contract-details type so consumers can reference it
export type { SaplingContractDetails };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECRET_KEY_METHOD = 'secretKey';
const MNEMONIC_METHOD = 'mnemonic';
const VIEWING_KEY_METHOD = 'viewingKey';

// ---------------------------------------------------------------------------
// Sapling parameter lazy-loading
// ---------------------------------------------------------------------------

/**
 * Custom URLs for sapling parameters (set by consumer via setSaplingParamsUrl).
 * When `null`, default resolution is used.
 */
let saplingParamsUrls: { spend: string; output: string } | null = null;

/** Whether sapling parameters have been initialized */
let saplingParamsInitialized = false;

/** In-flight loading promise (prevents duplicate loading) */
let saplingParamsLoading: Promise<void> | null = null;

/**
 * Resolve the default sapling params URLs based on the runtime environment.
 * - Browser web worker: relative to the worker script URL
 * - Node.js:            relative to this file on disk
 */
function getDefaultParamsUrls(): { spend: string; output: string } {
  /* eslint-disable no-restricted-globals */
  if (
    typeof self !== 'undefined' &&
    typeof (self as { location?: Location }).location !== 'undefined'
  ) {
    // Browser web worker — resolve relative to worker script URL
    const base = (self as { location: Location }).location.href.replace(
      /\/[^/]*$/,
      '/',
    );
    return {
      spend: `${base}sapling-spend.params`,
      output: `${base}sapling-output.params`,
    };
  }
  /* eslint-enable no-restricted-globals */

  // Node.js — resolve relative to __filename
  // eslint-disable-next-line no-eval
  const req = eval('require');
  const path = req('path');
  const dir = path.dirname(__filename);
  return {
    spend: `file://${path.join(dir, 'sapling-spend.params')}`,
    output: `file://${path.join(dir, 'sapling-output.params')}`,
  };
}

/** Fetch sapling parameters from a URL */
async function fetchParams(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch params from ${url}: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Initialize sapling parameters (lazy load from CDN / disk if not bundled).
 * Called automatically before any proof generation.
 */
const initSaplingParams = async (): Promise<void> => {
  if (saplingParamsInitialized) return;
  if (saplingParamsLoading) return saplingParamsLoading;

  saplingParamsLoading = (async () => {
    try {
      const urls = saplingParamsUrls ?? getDefaultParamsUrls();
      console.log('Loading sapling parameters...');
      const startTime = Date.now();

      const [spendParams, outputParams] = await Promise.all([
        fetchParams(urls.spend),
        fetchParams(urls.output),
      ]);

      await sapling.initParameters(spendParams, outputParams);
      saplingParamsInitialized = true;
      console.log(`Sapling parameters loaded in ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error('Failed to load sapling parameters:', error);
      throw error;
    } finally {
      saplingParamsLoading = null;
    }
  })();

  return saplingParamsLoading;
};

/** Check if sapling params are loaded */
const areSaplingParamsLoaded = (): boolean => saplingParamsInitialized;

/** Preload sapling params (call early to reduce latency) */
const preloadSaplingParams = (): void => {
  initSaplingParams().catch(console.error);
};

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let iMSK: InMemorySpendingKey | null = null;
let iMVK: InMemoryViewingKey | null = null;
let sTk: SaplingToolkit | null = null;
let isViewOnly = false;
let currentSaplingDetails: SaplingContractDetails | null = null;
let currentRpcAdapter: RpcReadAdapter | null = null;
let currentRpcUrl: string | null = null;

// ---------------------------------------------------------------------------
// Incremental sapling-diff cache (see saplingDiffCache.ts)
// ---------------------------------------------------------------------------
// When enabled, balance/transaction reads fetch only the diff DELTA (finalized prefix from a
// persisted offset + the fresh unconfirmed tail) instead of the full pool diff every time.
// The audited decrypt/spend path is unchanged — only the fetch is cheaper. Disabled => exactly
// the prior behaviour (full get_diff at head). Falls back to a full fetch on any cache error.
let diffCacheEnabled = false;
// v2: incremental DECRYPT (balance) cache. Opt-in (default off) — it caches decrypted notes and
// reimplements the balance sum, so it is gated behind a runtime self-check + full fallback.
let balanceCacheEnabled = false;
let diffStore: SaplingDiffStore | null = null;
let diffStoreResolved = false;

const setDiffCacheEnabled = (enabled: boolean): void => {
  diffCacheEnabled = enabled;
};

const setBalanceCacheEnabled = (enabled: boolean): void => {
  balanceCacheEnabled = enabled;
};

/** Inject a persistent store (Node/Lambda/tests). The browser auto-uses IndexedDB. */
const setDiffCacheStore = (store: SaplingDiffStore | null): void => {
  diffStore = store;
  diffStoreResolved = true;
};

/** Resolve the cache store, auto-creating the default (IndexedDB) one on first use. */
const resolveStore = (): SaplingDiffStore | null => {
  if (!diffStoreResolved) {
    diffStore = createDefaultDiffStore();
    diffStoreResolved = true;
  }
  return diffStore;
};

/**
 * The read provider the balance/tx viewer should use: the incremental caching wrapper when the
 * cache is enabled and a store is available, otherwise the plain RPC adapter (prior behaviour).
 */
const resolveReadProvider = (): RpcReadAdapter => {
  const adapter = currentRpcAdapter!;
  if (!diffCacheEnabled || !currentRpcUrl) return adapter;
  const store = resolveStore();
  if (!store) return adapter;
  return makeCachingReadProvider(adapter, currentRpcUrl, store);
};

/** The viewing key (FVK hex) for the loaded account — used to namespace/evict the balance cache. */
const currentFvkHex = async (): Promise<string | null> => {
  if (isViewOnly && iMVK)
    return Buffer.from(iMVK.getFullViewingKey()).toString('hex');
  if (iMSK) {
    const vk = await iMSK.getSaplingViewingKeyProvider();
    return Buffer.from(vk.getFullViewingKey()).toString('hex');
  }
  return null;
};

const saplingContractIdOf = () =>
  currentSaplingDetails!.saplingId
    ? { saplingId: currentSaplingDetails!.saplingId }
    : { contractAddress: currentSaplingDetails!.contractAddress };

const diffTargetOf = (): DiffTarget =>
  currentSaplingDetails!.saplingId
    ? { kind: 'id', id: currentSaplingDetails!.saplingId }
    : { kind: 'contract', id: currentSaplingDetails!.contractAddress };

// ---------------------------------------------------------------------------
// loadSaplingSecret idempotency cache
// ---------------------------------------------------------------------------
//
// A pooled worker is reused across many operations with an unchanging key and
// (usually) the same set/rpc. Without this guard every call re-runs
// InMemorySpendingKey.fromMnemonic (PBKDF2 + WASM key derivation) and rebuilds
// the SaplingToolkit + RPC adapter. Reusing the live handles is safe because
// SaplingToolkit and SaplingTransactionViewer always re-read on-chain state at
// 'head' on each call, so balances/roots are never served stale.
//
// The cache key holds the raw `sk` for an exact in-memory compare. This is not
// a new exposure: the same plaintext `sk` is already passed into the worker on
// every loadSaplingSecret call and the derived key material (iMSK) already lives
// here for the worker's lifetime; both die when the worker is terminated. We
// deliberately do NOT hash it — hashing would add a WebCrypto dependency that
// throws in non-secure browser contexts (no crypto.subtle), and the secret is
// invariant per worker so the key never needs to be cryptographic.
let lastSkType: string | null = null;
let lastSk: string | null = null;
let lastContractKey: string | null = null;
let lastRpcUrl: string | null = null;

const resetLoadCacheKeys = (): void => {
  lastSkType = null;
  lastSk = null;
  lastContractKey = null;
  lastRpcUrl = null;
};

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

const createExtendedSpendingKey = async (mnemonic: string) => {
  const fullSeed = await bip39.mnemonicToSeed(mnemonic);
  const first32 = fullSeed.subarray(0, 32);
  const second32 = fullSeed.subarray(32);
  const seed = Buffer.from(
    // eslint-disable-next-line no-bitwise
    first32.map((byte, index) => byte ^ second32[index]),
  );
  const spendingKeyArr = new Uint8Array(
    await sapling.getExtendedSpendingKey(seed, 'm/'),
  );

  return b58Encode(spendingKeyArr, PrefixV2.SaplingSpendingKey);
};

const loadSaplingSecret = async ({
  sk,
  saplingDetails,
  rpcUrl,
  skType = MNEMONIC_METHOD,
}: {
  sk: string;
  saplingDetails: SaplingContractDetails;
  rpcUrl: string;
  skType: 'secretKey' | 'mnemonic' | 'viewingKey';
}) => {
  const contractKey = `${
    saplingDetails.saplingId ?? saplingDetails.contractAddress
  }:${saplingDetails.memoSize}`;

  // Warm-worker fast path: the same key + contract + rpc are already loaded and
  // the required handles are live — reuse them without re-deriving the key or
  // rebuilding the toolkit. On-chain reads still happen at 'head' per call.
  const handlesLive =
    skType === VIEWING_KEY_METHOD
      ? isViewOnly && iMVK !== null
      : !isViewOnly && iMSK !== null && sTk !== null;
  if (
    skType === lastSkType &&
    sk === lastSk &&
    contractKey === lastContractKey &&
    rpcUrl === lastRpcUrl &&
    currentSaplingDetails !== null &&
    currentRpcAdapter !== null &&
    handlesLive
  ) {
    return;
  }

  try {
    // Reset previous state
    iMSK = null;
    iMVK = null;
    isViewOnly = false;

    if (skType === SECRET_KEY_METHOD) {
      iMSK = new InMemorySpendingKey(sk);
    } else if (skType === MNEMONIC_METHOD) {
      iMSK = await InMemorySpendingKey.fromMnemonic(sk);
    } else if (skType === VIEWING_KEY_METHOD) {
      iMVK = new InMemoryViewingKey(sk);
      isViewOnly = true;
    } else {
      throw new Error('Invalid account loading method provided');
    }

    // Store sapling details and RPC adapter for later use
    currentSaplingDetails = saplingDetails;
    currentRpcAdapter = new RpcReadAdapter(new RpcClient(rpcUrl));
    currentRpcUrl = rpcUrl;
  } catch (err) {
    iMSK = null;
    iMVK = null;
    sTk = null;
    isViewOnly = false;
    currentSaplingDetails = null;
    currentRpcAdapter = null;
    currentRpcUrl = null;
    resetLoadCacheKeys();
    throw err;
  }

  try {
    if (!isViewOnly) {
      sTk = new SaplingToolkit(
        { saplingSigner: iMSK! },
        saplingDetails,
        currentRpcAdapter,
      );
    } else {
      // View-only mode — no SaplingToolkit needed for transactions
      sTk = null;
    }
  } catch (err) {
    iMSK = null;
    iMVK = null;
    sTk = null;
    isViewOnly = false;
    currentSaplingDetails = null;
    currentRpcAdapter = null;
    currentRpcUrl = null;
    resetLoadCacheKeys();
    throw err;
  }

  // Record cache keys now that the load fully succeeded.
  lastSkType = skType;
  lastSk = sk;
  lastContractKey = contractKey;
  lastRpcUrl = rpcUrl;
};

const getViewingKey = async (): Promise<string> => {
  if (isViewOnly && iMVK) {
    const fvk = iMVK.getFullViewingKey();
    return Buffer.from(fvk).toString('hex');
  }
  if (iMSK) {
    const viewingKeyProvider = await iMSK.getSaplingViewingKeyProvider();
    const fvk = viewingKeyProvider.getFullViewingKey();
    return Buffer.from(fvk).toString('hex');
  }
  throw new Error('No spending key or viewing key loaded');
};

const getPaymentAddress = async () => {
  if (isViewOnly && iMVK) {
    return iMVK.getAddress();
  }
  if (iMSK) {
    const viewingKeyProvider = await iMSK.getSaplingViewingKeyProvider();
    return viewingKeyProvider.getAddress();
  }
  throw new Error('No spending key or viewing key loaded');
};

const prepareShieldedTransaction = async (
  shieldTransactions: ParametersSaplingTransaction[],
) => {
  if (isViewOnly) {
    throw new Error(
      'Cannot prepare transactions with a viewing key. A spending key is required.',
    );
  }
  await initSaplingParams();
  return sTk!.prepareShieldedTransaction(
    shieldTransactions as TaquitoSaplingTxParams[],
  );
};

const prepareUnshieldedTransaction = async (
  unshieldTransaction: ParametersUnshieldedTransaction,
) => {
  if (isViewOnly) {
    throw new Error(
      'Cannot prepare transactions with a viewing key. A spending key is required.',
    );
  }
  await initSaplingParams();
  return sTk!.prepareUnshieldedTransaction(
    unshieldTransaction as TaquitoUnshieldTxParams,
  );
};

const prepareSaplingTransaction = async (
  saplingTransactions: ParametersSaplingTransaction[] = [],
) => {
  if (isViewOnly) {
    throw new Error(
      'Cannot prepare transactions with a viewing key. A spending key is required.',
    );
  }
  await initSaplingParams();
  return sTk!.prepareSaplingTransaction(
    saplingTransactions as TaquitoSaplingTxParams[],
  );
};

/**
 * Build the read-only transaction viewer used by getSaplingBalance/getSaplingTransactions.
 * When the incremental diff cache is active, build the viewer directly over the caching read
 * provider (deriving the viewing key from the spending key for full accounts, which leaves
 * `sTk` — and therefore proof generation — completely untouched). When the cache is off, the
 * exact prior construction path is preserved.
 */
const buildViewer = async (): Promise<SaplingTransactionViewer> => {
  const provider = resolveReadProvider();
  const cachingActive = provider !== currentRpcAdapter;

  if (!cachingActive) {
    if (isViewOnly && iMVK) {
      if (!currentSaplingDetails || !currentRpcAdapter) {
        throw new Error('Sapling details not initialized');
      }
      const saplingContractId = currentSaplingDetails.saplingId
        ? { saplingId: currentSaplingDetails.saplingId }
        : { contractAddress: currentSaplingDetails.contractAddress };
      return new SaplingTransactionViewer(
        iMVK,
        saplingContractId,
        currentRpcAdapter,
      );
    }
    if (sTk) return sTk.getSaplingTransactionViewer();
    throw new Error('No sapling toolkit or viewing key available');
  }

  if (!currentSaplingDetails) {
    throw new Error('Sapling details not initialized');
  }
  let vk: InMemoryViewingKey;
  if (isViewOnly && iMVK) {
    vk = iMVK;
  } else if (iMSK) {
    vk = await iMSK.getSaplingViewingKeyProvider();
  } else {
    throw new Error('No sapling toolkit or viewing key available');
  }
  const saplingContractId = currentSaplingDetails.saplingId
    ? { saplingId: currentSaplingDetails.saplingId }
    : { contractAddress: currentSaplingDetails.contractAddress };
  return new SaplingTransactionViewer(vk, saplingContractId, provider);
};

const getSaplingBalance = async () => {
  // v2: incremental balance (decrypt-only-new) when opted in and a store is available. Drives the
  // per-account balance cache, which self-checks against the stock getBalance() and falls back on
  // any divergence or error — so it can never silently surface a wrong balance.
  if (
    balanceCacheEnabled &&
    diffCacheEnabled &&
    currentRpcUrl &&
    currentSaplingDetails
  ) {
    const store = resolveStore();
    let vk: InMemoryViewingKey | null = null;
    if (isViewOnly && iMVK) vk = iMVK;
    else if (iMSK) vk = await iMSK.getSaplingViewingKeyProvider();
    if (store && vk) {
      const viewer = new SaplingTransactionViewer(
        vk,
        saplingContractIdOf(),
        resolveReadProvider(),
      );
      const fvkHex = Buffer.from(vk.getFullViewingKey()).toString('hex');
      const balance = await incrementalBalance({
        store,
        rpcUrl: currentRpcUrl,
        target: diffTargetOf(),
        viewer: viewer as unknown as BalanceViewer,
        fvkHex,
      });
      return balance.toNumber();
    }
  }
  const txViewer = await buildViewer();
  const balance = await txViewer.getBalance();
  return balance.toNumber();
};

/** Evict this account's cached balances (call on account forget — removes decrypted data at rest). */
const clearShieldedBalanceCache = async (): Promise<void> => {
  const store = resolveStore();
  if (!store) return;
  const fvkHex = await currentFvkHex();
  if (fvkHex) await clearForViewingKey(store, fvkHex);
};

// Readable conversion of a raw note (mirrors octez.js's internal `readableFormat`, which isn't
// re-exported): value bytes → base-16 number, memo bytes → utf8 (trailing zero-padding stripped),
// payment address bytes → zet1… b58.
const noteValue = (v: Uint8Array): number =>
  new BigNumber(Buffer.from(v).toString('hex'), 16).toNumber();
const noteMemo = (m: Uint8Array): string => {
  const hex = Buffer.from(m).toString('hex');
  const match = hex.match(/^(.*?)(?:00)+$/);
  const trimmed = match ? match[1] : hex;
  return trimmed === '' ? '' : bytesToString(trimmed);
};
const noteAddress = (a: Uint8Array): string =>
  b58Encode(a, PrefixV2.SaplingAddress);
const rcmHex = (r: Uint8Array): string => Buffer.from(r).toString('hex');

/** A raw note as returned by SaplingTransactionViewer.getIncomingAndOutgoingTransactionsRaw(). */
export interface RawSaplingNote {
  value: Uint8Array;
  memo: Uint8Array;
  paymentAddress: Uint8Array;
  randomCommitmentTrapdoor: Uint8Array;
  isSpent?: boolean;
}

/**
 * Format raw incoming/outgoing notes and tag the "self-sent" set. A note you created to YOURSELF
 * (change, or a shield to your own address) is decryptable as BOTH receiver and sender, so it shows
 * up in the incoming AND outgoing lists with the SAME commitment trapdoor (rcm). Matching by rcm
 * flags that set EXACTLY — no address/value/memo guessing — so the app can separate real
 * receives/sends from internal change no matter which diversified address the change went to.
 * Pure + exported for unit testing.
 */
export function notesToHistory(raw: {
  incoming: RawSaplingNote[];
  outgoing: RawSaplingNote[];
}) {
  const incomingRcm = new Set(
    raw.incoming.map((t) => rcmHex(t.randomCommitmentTrapdoor)),
  );
  const outgoingRcm = new Set(
    raw.outgoing.map((t) => rcmHex(t.randomCommitmentTrapdoor)),
  );
  return {
    incoming: raw.incoming.map((t) => ({
      value: noteValue(t.value),
      memo: noteMemo(t.memo),
      paymentAddress: noteAddress(t.paymentAddress),
      isSpent: !!t.isSpent,
      isChange: outgoingRcm.has(rcmHex(t.randomCommitmentTrapdoor)),
    })),
    outgoing: raw.outgoing.map((t) => ({
      value: noteValue(t.value),
      memo: noteMemo(t.memo),
      paymentAddress: noteAddress(t.paymentAddress),
      isChange: incomingRcm.has(rcmHex(t.randomCommitmentTrapdoor)),
    })),
  };
}

const getSaplingTransactions = async () => {
  const txViewer = await buildViewer();
  // RAW viewer (same decryption cost as the readable one — it's what readable wraps) so we get each
  // note's rcm for the self-sent / change detection in notesToHistory.
  const raw = await txViewer.getIncomingAndOutgoingTransactionsRaw();
  return notesToHistory(raw);
};

const reInitializeSapling = () => {
  iMSK = null;
  iMVK = null;
  sTk = null;
  isViewOnly = false;
  currentSaplingDetails = null;
  currentRpcAdapter = null;
  currentRpcUrl = null;
  resetLoadCacheKeys();
};

/**
 * Set custom base URL for sapling parameters.
 * Must be called before any proof generation (before initSaplingParams).
 */
const setSaplingParamsUrl = (baseUrl: string): void => {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  saplingParamsUrls = {
    spend: `${normalizedBase}sapling-spend.params`,
    output: `${normalizedBase}sapling-output.params`,
  };
};

/**
 * Set explicit URLs for individual sapling parameter files.
 * Must be called before any proof generation (before initSaplingParams).
 */
const setSaplingParamsUrls = (urls: {
  spend: string;
  output: string;
}): void => {
  saplingParamsUrls = { ...urls };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const saplingWorkerCore = {
  createExtendedSpendingKey,
  loadSaplingSecret,
  getPaymentAddress,
  getViewingKey,
  prepareShieldedTransaction,
  prepareUnshieldedTransaction,
  prepareSaplingTransaction,
  getSaplingBalance,
  getSaplingTransactions,
  reInitializeSapling,
  initSaplingParams,
  areSaplingParamsLoaded,
  preloadSaplingParams,
  setSaplingParamsUrl,
  setSaplingParamsUrls,
  setDiffCacheEnabled,
  setBalanceCacheEnabled,
  setDiffCacheStore,
  clearShieldedBalanceCache,
};

export type SaplingWorkerCore = typeof saplingWorkerCore;
