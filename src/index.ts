import { Buffer } from 'buffer';
import * as Comlink from 'comlink';
import {
  ContractAbstraction,
  ContractMethodObject,
  ContractProvider,
  OpKind,
  TezosToolkit,
  TransferParams as TaquitoTransferParams,
  Wallet,
  withKind,
  WalletOperation,
} from '@tezos-x/octez.js';
import { BlockResponse } from '@tezos-x/octez.js-rpc';
import BigNumber from 'bignumber.js';
import type { SaplingWorker } from './worker.js';
import { SaplingWorkerPool, DEFAULT_POOL_SIZE } from './workerPool.js';
import type { PoolEntry } from './workerPool.js';
import type {
  ContractArchitecture,
  ShieldParams,
  UnshieldParams,
  TransferParams,
  SaplingTokenInfo,
  TransactionProgressCallbacks,
  ShieldBridgeSDKConfig,
  FactoryTransactionItem,
  OrderedTransactionList,
  SaplingDeposits,
  SaplingTransactions,
  FactoryStorage,
  ShieldedAssetInfo,
  TokenMetadata,
  TzKTTokenBalance,
} from './types.js';
import { OperationIndex } from './types.js';
import {
  shieldBridgeContract as shieldBridgeContractAddresses,
  saplingMapContract,
  tzktApiMap,
} from './constants.js';
import { toBaseUnits, validateAmount } from './utils/amount.js';
import type { SaplingDiffStore } from './saplingDiffCache.js';

// Types — re-exported for consumers
export type {
  ContractArchitecture,
  AmountInput,
  ShieldParams,
  UnshieldParams,
  TransferParams,
  SaplingTokenInfo,
  TransactionProgressCallbacks,
  ShieldBridgeSDKConfig,
  FactoryStorage,
  ShieldedAssetInfo,
  TokenMetadata,
  TzKTTokenBalance,
} from './types.js';

// Constants — re-exported for consumers
export {
  shieldBridgeContract,
  saplingFactoryContract,
  saplingMapContract,
  saplingStateMapContract,
  tzktApiMap,
} from './constants.js';

// Worker pool — re-exported for consumers
export {
  SaplingWorkerPool,
  DEFAULT_POOL_SIZE,
  DEFAULT_IDLE_TIMEOUT_MS,
} from './workerPool.js';
export type { PoolEntry } from './workerPool.js';

// Sapling core types — only the type is re-exported to avoid pulling
// @tezos-x/octez.js-sapling (which has top-level require() calls for
// sapling params files) into browser bundles.
// For direct (thread-free) execution, use new ShieldBridgeSDK({ parallelThreads: false })
// which dynamically imports saplingCore at runtime.
export type { SaplingWorkerCore } from './saplingCore.js';

// Incremental sapling-diff cache — safe to re-export as values (no heavy deps; uses only
// fetch + IndexedDB), so Node/Lambda consumers can inject a store.
export {
  MemoryDiffStore,
  IndexedDbDiffStore,
  createDefaultDiffStore,
  makeCachingReadProvider,
} from './saplingDiffCache.js';
export type {
  SaplingDiffStore,
  CachedSaplingDiff,
  SaplingDiffResponse,
} from './saplingDiffCache.js';

// Make Buffer available globally for octez.js dependencies
if (typeof window !== 'undefined' && !window.Buffer) {
  window.Buffer = Buffer;
}

const isBrowser: boolean =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Default to loading the unbundled worker
let workerUrl = './worker';

// Default sapling params URLs — resolved by the consumer's bundler via import.meta.url
// Bundlers (Vite, webpack 5) recognize `new URL('./file', import.meta.url)` and emit the
// referenced files as separate assets, returning the final public URL automatically.
let defaultSpendParamsUrl: string | undefined;
let defaultOutputParamsUrl: string | undefined;

if (isBrowser) {
  // Load the worker bundle in the browser environment
  workerUrl = new URL('./saplingWorker.js', import.meta.url).href;
  // Resolve sapling params relative to this module — bundler copies them to output
  defaultSpendParamsUrl = new URL('./sapling-spend.params', import.meta.url)
    .href;
  defaultOutputParamsUrl = new URL('./sapling-output.params', import.meta.url)
    .href;
}

/**
 * ShieldBridgeSDK provides an abstraction to interact with the Shield Bridge smart contract
 * to shield, unshield, and transfer sapling tokens.
 *
 * The SDK supports two modes of operation:
 *
 * 1. **Full Access Mode** (with spending key or mnemonic):
 *    - Can perform all operations: shield, unshield, transfer
 *    - Can query balances and transactions
 *    - Can export viewing keys for read-only access
 *
 * 2. **View-Only Mode** (with viewing key):
 *    - Can only query balances and transactions
 *    - Cannot perform transaction operations
 *    - Useful for auditing, monitoring, and compliance
 *
 * @class
 * @param {ShieldBridgeSDKConfig} config The configuration object for the Shield Bridge SDK
 * @param {TezosToolkit} config.client The TezosToolkit instance
 * @param {'mainnet' | 'shadownet'} [config.tzktApi='mainnet'] The tzkt API to use
 * @param {number} [config.minConfirmations=1] The minimum number of confirmations for the transaction
 * @param {string} [config.saplingStateMapContract='KT1RYEs6rfXgHqeb2XzfHKRii5NsNyKbS6WM'] The sapling state map contract address
 * @param {boolean} [config.useBaseUnits=false] Whether to use base unit for the token amounts (mutez or token units with decimals)
 * @param {boolean} [config.parallelThreads=true] Whether to spawn parallel threads for the sapling worker
 * @param {string} [config.saplingSecret] The sapling secret key (for full access mode)
 * @param {string} [config.saplingMnemonic] The sapling mnemonic (for full access mode)
 * @param {string} [config.saplingViewingKey] The sapling viewing key (for view-only mode)
 * @returns {ShieldBridgeSDK} The Shield Bridge SDK instance
 *
 * @example
 * // Full access mode with secret key
 * const tezos = new TezosToolkit('https://mainnet.api.tez.ie');
 * const signerProvider = await InMemorySigner.fromSecretKey('edsk...');
 * tezos.setSignerProvider(signerProvider);
 * const shieldBridge = new ShieldBridgeSDK({
 *   client: tezos,
 *   saplingSecret: 'sask...'
 * });
 * await shieldBridge.shield([
 *   {
 *     amount: 1,
 *     contract: 'KT1...',
 *     tokenId: 0,
 *     memo: 'abcdefgh'
 *   }
 * ]);
 *
 * @example
 * // Export viewing key for read-only access
 * const viewingKey = await shieldBridge.getViewingKey();
 *
 * @example
 * // View-only mode with viewing key
 * const viewOnlySdk = new ShieldBridgeSDK({
 *   client: tezos,
 *   saplingViewingKey: 'abc123...'
 * });
 * const balance = await viewOnlySdk.getShieldedBalance({});
 * console.log('View-only mode:', viewOnlySdk.isViewOnlyMode); // true
 */
export class ShieldBridgeSDK {
  private tezosClient: TezosToolkit;

  private saplingWorker!: Comlink.Remote<SaplingWorker>;

  /** Worker pool for parallel operations (null when parallelThreads is false) */
  private workerPool: SaplingWorkerPool | null = null;

  /**
   * The contract address used for operations.
   * - V2: Factory contract address
   * - V1: Map contract address
   * @deprecated Use shieldBridgeContractAddress instead.
   */
  get saplingStateMapContract(): string {
    return this.shieldBridgeContractAddress;
  }

  /**
   * The Shield Bridge contract address used for operations.
   * - V2: Factory contract address
   * - V1: Map contract address
   */
  shieldBridgeContractAddress: string;

  /**
   * Contract architecture version
   * - '2': Factory contract with individual set contracts
   * - '1': Legacy map contract with inline sapling states
   * Can be changed at runtime via switchArchitecture()
   */
  contractArchitecture: ContractArchitecture;

  minConfirmations: number;

  useBaseUnits: boolean;

  parallelThreads: boolean;

  /** Maximum pool size when parallelThreads is enabled */
  private maxPoolSize: number;

  /** TzKT API base URL for this SDK instance */
  private tzktBaseUrl: string;

  /** Counter for in-flight operations to prevent architecture switches during active work */
  private operationsInFlight = 0;

  ready: Promise<boolean>;

  /**
   * Indicates whether the SDK is in view-only mode (using a viewing key)
   * When true, only read operations (balance, transactions, address) are available
   * Transaction operations (shield, unshield, transfer) will throw errors
   */
  readonly isViewOnlyMode: boolean;

  /**
   * Await op.confirmation() with a visibility-change recovery for mobile browsers.
   *
   * When the user switches to a wallet app to sign, the browser tab is backgrounded
   * and timers are throttled/frozen. op.confirmation() uses RxJS polling (setInterval)
   * that stalls on backgrounded tabs. The polling resumes on return but needs to walk
   * through every missed block sequentially, which can take a very long time.
   *
   * This helper races op.confirmation() against visibility/focus listeners that
   * query TzKT for the operation status when the tab regains focus, bypassing the
   * stalled block-by-block walk entirely.
   *
   * Uses both `visibilitychange` and `focus` because iOS Safari sometimes fails
   * to fire `visibilitychange` when switching between native apps.
   */
  private awaitConfirmation = (
    op: WalletOperation,
  ): Promise<Record<string, unknown>> => {
    if (typeof document === 'undefined') {
      return op.confirmation(this.minConfirmations) as Promise<
        Record<string, unknown>
      >;
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const checkTzKT = () => {
        if (settled) return;
        fetch(`${this.tzktBaseUrl}/v1/operations/${op.opHash}`)
          .then((res) => (res.ok ? res.json() : null))
          .then((data: unknown) => {
            if (data && Array.isArray(data) && data.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-use-before-define
              settle(data[0] as Record<string, unknown>);
            }
          })
          .catch(() => {
            // TzKT unavailable — fall through to normal polling
          });
      };

      const onResume = () => {
        if (settled) return;
        // For visibilitychange, only act when becoming visible
        if (
          document.visibilityState !== undefined &&
          document.visibilityState !== 'visible'
        ) {
          return;
        }
        checkTzKT();
      };

      const cleanup = () => {
        document.removeEventListener('visibilitychange', onResume);
        window.removeEventListener('focus', onResume);
      };

      const settle = (result: Record<string, unknown>) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      };

      const fail = (err: unknown) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      // visibilitychange: standard API, works on most browsers
      // focus: fallback for iOS Safari app-switching where visibilitychange can miss
      document.addEventListener('visibilitychange', onResume);
      window.addEventListener('focus', onResume);

      // Immediate TzKT check: on mobile, the user may return to the app
      // (triggering visibilitychange) BEFORE batch.send() resolves and
      // awaitConfirmation registers its listeners. By the time we get here
      // the page is already visible and no new event will fire.
      if (document.visibilityState === 'visible') {
        checkTzKT();
      }

      (
        op.confirmation(this.minConfirmations) as Promise<
          Record<string, unknown>
        >
      )
        .then(settle)
        .catch(fail);
    });
  };

  // Cache for set contract addresses (V2) or sapling IDs (V1)
  private setAddressCache: Map<string, Promise<string | undefined>> = new Map();

  // Cache for sapling IDs (V1 only)
  private saplingIdCache: Map<string, Promise<number | undefined>> = new Map();

  private tokenDecimalsCache: Map<string, Promise<number>> = new Map();

  private tokenMetadataCache: Map<string, Promise<TokenMetadata>> = new Map();

  // Cache for contract instances
  private walletContractCache: Map<string, ContractAbstraction<Wallet>> =
    new Map();

  private estimatorContractCache: Map<
    string,
    ContractAbstraction<ContractProvider>
  > = new Map();

  /**
   * Memoized factory storage snapshot (V2). The factory abstraction and its
   * top-level storage are immutable for a given contract address, and big-map
   * `.get()` lookups always issue a fresh head RPC, so a single snapshot serves
   * every per-token set-address lookup without re-fetching the storage.
   * Reset on architecture switch, destroy, and on fetch error.
   */
  private factoryStoragePromise: Promise<FactoryStorage> | null = null;

  /**
   * Memoized deterministic outputs of the loaded sapling key. The shielded
   * payment address and the viewing key are pure functions of the key — which
   * is fixed for the SDK's lifetime and only cleared in destroy — and do not
   * depend on the contract architecture, so they are derived once and reused.
   * Reset to undefined on failure so a transient worker/WASM error stays
   * retryable; cleared in destroy.
   */
  private shieldedAddressPromise?: Promise<string>;

  private viewingKeyPromise?: Promise<string>;

  // ── Secret storage (true JS private — inaccessible at runtime) ──
  /** The sapling key type and value, extracted once and never re-exposed */
  #saplingKeyInfo: {
    skType: 'secretKey' | 'mnemonic' | 'viewingKey';
    sk: string;
  };

  // ── Non-secret config values extracted for lifetime use ──
  /** Custom base URL for sapling params (overrides default relative resolution) */
  private saplingParamsUrl?: string;

  /** Whether the incremental sapling-diff (fetch) cache is enabled (default true). */
  private saplingDiffCache: boolean;

  /** Whether the incremental balance (decrypt) cache is enabled (opt-in, default false). */
  private saplingBalanceCache: boolean;

  /** Optional injected diff-cache store (Node/Lambda/tests; direct-execution mode). */
  private saplingDiffStore?: SaplingDiffStore;

  /** Network identifier for default contract address resolution */
  private network: 'mainnet' | 'shadownet';

  constructor(config: ShieldBridgeSDKConfig) {
    this.tezosClient = config.client;
    this.minConfirmations = config.minConfirmations ?? 1;

    // ── Extract and protect secrets immediately ──
    if (config.saplingSecret) {
      this.#saplingKeyInfo = { skType: 'secretKey', sk: config.saplingSecret };
    } else if (config.saplingViewingKey) {
      this.#saplingKeyInfo = {
        skType: 'viewingKey',
        sk: config.saplingViewingKey,
      };
    } else if (config.saplingMnemonic) {
      this.#saplingKeyInfo = { skType: 'mnemonic', sk: config.saplingMnemonic };
    } else {
      throw new Error(
        'One of saplingSecret, saplingMnemonic, or saplingViewingKey must be provided.',
      );
    }

    // Extract non-secret config values we need after construction
    this.saplingParamsUrl = config.saplingParamsUrl;
    this.saplingDiffCache = config.saplingDiffCache ?? true;
    this.saplingBalanceCache = config.saplingBalanceCache ?? false;
    this.saplingDiffStore = config.saplingDiffStore;
    this.network = (config.tzktApi || 'mainnet') as 'mainnet' | 'shadownet';

    // Determine contract architecture (V2 is default)
    this.contractArchitecture = config.contractArchitecture ?? '2';

    // Warn if using deprecated V1 architecture
    if (this.contractArchitecture === '1') {
      console.warn(
        '[ShieldBridgeSDK] V1 (Map contract) architecture is deprecated. ' +
          'Please migrate to V2 (Factory contract) for new transactions. ' +
          'V1 support is provided for fund migration only.',
      );
    }

    // Select contract address based on architecture
    // Accepts shieldBridgeContract (preferred), saplingFactoryContract, saplingMapContract, or saplingStateMapContract (all deprecated aliases)
    if (this.contractArchitecture === '1') {
      // V1: Use map contract
      this.shieldBridgeContractAddress =
        config.shieldBridgeContract ??
        config.saplingMapContract ??
        config.saplingStateMapContract ??
        saplingMapContract[config.tzktApi || 'mainnet'];
    } else {
      // V2: Use factory contract
      this.shieldBridgeContractAddress =
        config.shieldBridgeContract ??
        config.saplingFactoryContract ??
        config.saplingStateMapContract ??
        shieldBridgeContractAddresses[config.tzktApi || 'mainnet'];
    }

    this.useBaseUnits = config.useBaseUnits ?? false;
    this.maxPoolSize =
      typeof config.parallelThreads === 'number'
        ? Math.max(1, Math.min(config.parallelThreads, DEFAULT_POOL_SIZE))
        : DEFAULT_POOL_SIZE;
    this.parallelThreads =
      typeof config.parallelThreads === 'number'
        ? true
        : (config.parallelThreads ?? true);
    this.isViewOnlyMode = !!config.saplingViewingKey;
    this.tzktBaseUrl = tzktApiMap[this.network];
    this.ready = this.initializeSaplingWorker();

    // ── Scrub secrets from the config object so they cannot leak ──
    // Even if the caller retains a reference to the config, the secrets
    // lived on an object literal that is now cleaned.
    // eslint-disable-next-line no-param-reassign
    delete (config as Record<string, unknown>).saplingSecret;
    // eslint-disable-next-line no-param-reassign
    delete (config as Record<string, unknown>).saplingMnemonic;
    // eslint-disable-next-line no-param-reassign
    delete (config as Record<string, unknown>).saplingViewingKey;
  }

  /**
   * @description Helper to create a worker instance compatible with both Browser and Node.js
   */
  private createWorker = async (): Promise<Comlink.Remote<SaplingWorker>> => {
    let worker;
    let endpoint;

    if (typeof window === 'undefined') {
      // Node.js environment
      // eslint-disable-next-line no-eval
      const req = eval('require');
      const { Worker } = req('worker_threads');
      const nodeEndpoint = req('comlink/dist/umd/node-adapter');
      const path = req('path');
      const { fileURLToPath } = req('url');

      // Resolve path to the Node worker bundle relative to this file.
      // In dist/, index.js and saplingWorker.cjs are siblings. We load the
      // `.cjs` (CommonJS) Node bundle here — NOT the browser `saplingWorker.js`
      // — because package.json sets "type":"module", so Node would evaluate a
      // `.js` worker as ESM where the worker's `eval('require')` throws.
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const workerPath = path.join(currentDir, 'saplingWorker.cjs');

      worker = new Worker(workerPath);
      endpoint = nodeEndpoint(worker);
    } else {
      // Browser environment
      worker = new Worker(workerUrl);
      endpoint = worker;
    }

    const proxy = Comlink.wrap<SaplingWorker>(endpoint);

    // Wire sapling params URLs to the worker
    // Priority: explicit saplingParamsUrl config > bundler-resolved URLs > worker's own resolution
    if (this.saplingParamsUrl) {
      await proxy.setSaplingParamsUrl(this.saplingParamsUrl);
    } else if (defaultSpendParamsUrl && defaultOutputParamsUrl) {
      await proxy.setSaplingParamsUrls({
        spend: defaultSpendParamsUrl,
        output: defaultOutputParamsUrl,
      });
    }

    // Incremental diff cache: enable per worker. The store itself is NOT sent across the
    // Comlink boundary (it can't carry methods) — inside a Web Worker the cache auto-uses
    // IndexedDB (shared across same-origin workers). Node worker_threads have no IndexedDB,
    // so caching there is a no-op unless direct-execution mode + an injected store is used.
    await proxy.setDiffCacheEnabled(this.saplingDiffCache);
    await proxy.setBalanceCacheEnabled(this.saplingBalanceCache);

    return proxy;
  };

  initializeSaplingWorker = async () => {
    try {
      // Direct execution mode: when parallelThreads is false in Node.js,
      // use saplingCore directly without spawning any worker threads.
      // This is essential for environments like AWS Lambda where worker_threads
      // add unnecessary overhead and complexity.
      if (!isBrowser && !this.parallelThreads) {
        const { saplingWorkerCore } = await import('./saplingCore.js');
        // The core functions have the same async interface as Comlink.Remote<SaplingWorker>
        // since all functions return Promises, making the cast safe at runtime.
        this.saplingWorker =
          saplingWorkerCore as unknown as Comlink.Remote<SaplingWorker>;

        // Wire sapling params URLs for direct mode
        if (this.saplingParamsUrl) {
          saplingWorkerCore.setSaplingParamsUrl(this.saplingParamsUrl);
        }

        // Incremental diff cache for direct mode. Here we CAN inject a store object (same
        // execution context — no Comlink boundary), so Node/Lambda can opt in with
        // `saplingDiffStore`; otherwise it auto-uses IndexedDB if present, else stays a no-op.
        saplingWorkerCore.setDiffCacheEnabled(this.saplingDiffCache);
        saplingWorkerCore.setBalanceCacheEnabled(this.saplingBalanceCache);
        if (this.saplingDiffStore) {
          saplingWorkerCore.setDiffCacheStore(this.saplingDiffStore);
        }

        return true;
      }

      // In parallel mode the pool owns all workers (created lazily on checkout),
      // and every executor reassigns its worker from the pool before use — so a
      // standalone primary worker would be spawned but never run. Only the
      // single-worker path (browser + parallelThreads:false) needs a primary.
      if (this.parallelThreads) {
        this.workerPool = new SaplingWorkerPool(this.maxPoolSize, () =>
          this.createWorker(),
        );
      } else {
        this.saplingWorker = await this.createWorker();
      }

      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        '[ShieldBridgeSDK] Failed to initialize Sapling worker:',
        message,
      );
      throw new Error(`Failed to initialize Sapling worker: ${message}`);
    }
  };

  /**
   * @description Get the sapling key type and value
   * @returns The key type ('secretKey' | 'mnemonic' | 'viewingKey') and the key value
   */
  private getSaplingKeyInfo = (): {
    skType: 'secretKey' | 'mnemonic' | 'viewingKey';
    sk: string;
  } => this.#saplingKeyInfo;

  /**
   * @description Format token info for error messages
   */
  private static formatTokenInfo(contract?: string, tokenId?: number): string {
    if (!contract) return 'tez';
    return `contract ${contract}${tokenId !== undefined ? ` tokenId ${tokenId}` : ''}`;
  }

  /**
   * @description Get cached contract or fetch and cache it
   * @param contractAddress The contract address
   */
  private getContract = async (contractAddress: string) => {
    const cached = this.walletContractCache.get(contractAddress);
    if (cached) return cached;

    const contract = await this.tezosClient.wallet.at(contractAddress);
    this.walletContractCache.set(contractAddress, contract);
    return contract;
  };

  /**
   * @description Get cached estimator contract or fetch and cache it
   * @param contractAddress The contract address
   */
  private getEstimatorContract = async (contractAddress: string) => {
    const cached = this.estimatorContractCache.get(contractAddress);
    if (cached) return cached;

    const contract = await this.tezosClient.contract.at(contractAddress);
    this.estimatorContractCache.set(contractAddress, contract);
    return contract;
  };

  /**
   * @description Get the memoized factory storage snapshot (V2), reusing the
   * cached factory contract abstraction. Big-map `.get()` lookups off the
   * snapshot stay live (each issues a fresh head RPC), so this only collapses
   * the repeated `contract.at()` + `storage()` round-trips, not per-token
   * freshness. Used by getSetAddress, which holds its own per-key result cache.
   */
  private getFactoryStorage = (): Promise<FactoryStorage> => {
    if (this.factoryStoragePromise) {
      return this.factoryStoragePromise;
    }

    const storagePromise = (async () => {
      const factoryContract = await this.getEstimatorContract(
        this.shieldBridgeContractAddress,
      );
      return factoryContract.storage<FactoryStorage>();
    })();

    // Null out on rejection so a transient RPC failure doesn't poison every
    // subsequent token lookup with a permanently-rejected promise.
    storagePromise.catch(() => {
      if (this.factoryStoragePromise === storagePromise) {
        this.factoryStoragePromise = null;
      }
    });

    this.factoryStoragePromise = storagePromise;
    return storagePromise;
  };

  /**
   * @description Helper method to initialize a sapling worker with the sapling secret and state
   * @param contract The token contract address (optional)
   * @param tokenId The token id (optional)
   * @param providedSetAddress The set contract address if already known (V2 only, optional)
   * @param providedSaplingId The sapling ID if already known (V1 only, optional)
   * @returns The initialized sapling worker, set address/map contract, and token decimals
   */
  private initializeSaplingWorkerWithState = async (
    contract?: string,
    tokenId?: number,
    providedSetAddress?: string,
    providedSaplingId?: number,
  ): Promise<{
    saplingWorker: Comlink.Remote<SaplingWorker>;
    setAddress: string;
    tokenDecimals: number;
    poolEntry: PoolEntry | null;
  }> => {
    let poolEntry: PoolEntry | null = null;
    try {
      await this.ready;
      let { saplingWorker } = this;
      if (this.workerPool) {
        poolEntry = await this.workerPool.checkout();
        saplingWorker = poolEntry.worker;
      }

      // Determine the key type and value based on what's provided in the config
      const { sk, skType } = this.getSaplingKeyInfo();

      // Handle V1 vs V2 architecture differently
      let setAddress: string;

      if (this.contractArchitecture === '1') {
        // V1: Use saplingId and map contract
        const saplingId =
          providedSaplingId ?? (await this.getSaplingId(contract, tokenId));
        if (saplingId === undefined) {
          throw new Error(
            `Sapling state not initialized for ${ShieldBridgeSDK.formatTokenInfo(contract, tokenId)}`,
          );
        }

        await saplingWorker.loadSaplingSecret({
          sk,
          skType,
          saplingDetails: {
            contractAddress: this.shieldBridgeContractAddress,
            memoSize: 8,
            saplingId: `${saplingId}`,
          },
          rpcUrl: this.tezosClient.rpc.getRpcUrl(),
        });

        // For V1, setAddress is the map contract itself
        setAddress = this.shieldBridgeContractAddress;
      } else {
        // V2: Use setAddress (individual set contract)
        // Fetch set address and token decimals in parallel (both independent)
        const decimalsPromise = contract
          ? this.getTokenDecimals(contract, tokenId)
          : Promise.resolve(6);

        const fetchedSetAddress =
          providedSetAddress ?? (await this.getSetAddress(contract, tokenId));
        if (!fetchedSetAddress) {
          throw new Error(
            `Sapling set not initialized for ${ShieldBridgeSDK.formatTokenInfo(contract, tokenId)}`,
          );
        }

        await saplingWorker.loadSaplingSecret({
          sk,
          skType,
          saplingDetails: {
            contractAddress: fetchedSetAddress,
            memoSize: 8,
          },
          rpcUrl: this.tezosClient.rpc.getRpcUrl(),
        });

        setAddress = fetchedSetAddress;

        // Await decimals (likely already resolved since set address fetch was slower)
        const tokenDecimals = await decimalsPromise;
        return { saplingWorker, setAddress, tokenDecimals, poolEntry };
      }

      // V1 path: fetch token decimals sequentially (after loadSaplingSecret)
      let tokenDecimals = 6;
      if (contract) {
        tokenDecimals = await this.getTokenDecimals(contract, tokenId);
      }

      return { saplingWorker, setAddress, tokenDecimals, poolEntry };
    } catch (error: unknown) {
      // Release pool entry on error to prevent pool exhaustion
      if (poolEntry) {
        this.workerPool?.release(poolEntry);
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize sapling worker for ${ShieldBridgeSDK.formatTokenInfo(contract, tokenId)}: ${errorMessage}`,
      );
    }
  };

  /**
   * @description Execute an operation with a properly managed sapling worker.
   * Ensures the parallel worker is always released after the operation completes
   * or throws, preventing memory leaks from orphaned Web Workers.
   *
   * @param fn Callback receiving the initialized worker, token decimals, and set address
   * @param contract Optional token contract address
   * @param tokenId Optional token ID
   * @param providedSetAddress Optional pre-resolved set address (V2)
   * @param providedSaplingId Optional pre-resolved sapling ID (V1)
   * @returns The result of the callback
   */
  private withWorker = async <T>(
    fn: (
      saplingWorker: Comlink.Remote<SaplingWorker>,
      tokenDecimals: number,
      setAddress: string,
    ) => Promise<T>,
    contract?: string,
    tokenId?: number,
    providedSetAddress?: string,
    providedSaplingId?: number,
  ): Promise<T> => {
    const { saplingWorker, setAddress, tokenDecimals, poolEntry } =
      await this.initializeSaplingWorkerWithState(
        contract,
        tokenId,
        providedSetAddress,
        providedSaplingId,
      );
    try {
      return await fn(saplingWorker, tokenDecimals, setAddress);
    } finally {
      if (poolEntry) {
        this.workerPool?.release(poolEntry);
      }
    }
  };

  /**
   * @description Get the sapling set contract address for the token contract and token id if provided
   * @param {string} [contract] The token contract address
   * @param {number} [tokenId] The token id
   * @returns The sapling set contract address for the token contract and token id if provided
   * @note This method is for V2 (Factory) architecture. For V1, use getSaplingId instead.
   */
  getSetAddress = async (contract?: string, tokenId?: number) => {
    // Create cache key
    const cacheKey = contract
      ? `${contract}${tokenId !== undefined ? `:${tokenId}` : ''}`
      : 'tez';

    // Check cache first and return the promise if it exists
    if (this.setAddressCache.has(cacheKey)) {
      return this.setAddressCache.get(cacheKey)!;
    }

    // Create and cache the promise to prevent duplicate concurrent requests
    const setAddressPromise = (async () => {
      try {
        let setAddress: string | undefined;

        if (contract) {
          // Token sets use the memoized factory storage snapshot — the big-map
          // `.get()` below still hits RPC fresh at head, so the snapshot only
          // collapses the repeated storage fetch and never freezes a result.
          const factoryStorage = await this.getFactoryStorage();
          if (tokenId !== undefined) {
            // FA2 token - lookup in token_fa_2 big map
            setAddress = await factoryStorage.token_fa_2.get({
              contract,
              token_id: tokenId,
            });
          } else {
            // FA1.2 token - lookup in token_fa_1_2 big map
            setAddress = await factoryStorage.token_fa_1_2.get(contract);
          }
        } else {
          // TEZ is a plain storage field, not a live big-map getter, so the
          // memoized snapshot would freeze it for the SDK lifetime. Fetch fresh
          // (via the cached factory abstraction) so a tez set deployed
          // mid-session is picked up — the undefined-eviction below keeps
          // re-resolving it until then.
          const factoryContract = await this.getEstimatorContract(
            this.shieldBridgeContractAddress,
          );
          const factoryStorage =
            await factoryContract.storage<FactoryStorage>();
          setAddress = factoryStorage.tez || undefined;
        }

        return setAddress;
      } catch (error: unknown) {
        // Remove from cache on error so it can be retried
        this.setAddressCache.delete(cacheKey);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to get set address for ${cacheKey}: ${message}`,
        );
      }
    })();

    // Cache the promise immediately before any await
    this.setAddressCache.set(cacheKey, setAddressPromise);

    // Don't pin a not-yet-initialized set (undefined) forever: evict it once
    // resolved so a later initTokenSaplingSet is picked up on the next lookup.
    // Deployed (immutable) set addresses stay cached. The identity guard avoids
    // clobbering a concurrent getAllShieldedAssets population of the same key.
    setAddressPromise
      .then((value) => {
        if (
          value === undefined &&
          this.setAddressCache.get(cacheKey) === setAddressPromise
        ) {
          this.setAddressCache.delete(cacheKey);
        }
      })
      .catch(() => {
        // Rejections already evict via the catch above.
      });

    return setAddressPromise;
  };

  /**
   * @deprecated V1 architecture is deprecated. Use V2 (Factory) with getSetAddress instead.
   * @description Get the sapling ID for the token contract and token id (V1 Map architecture)
   * @param {string} [contract] The token contract address
   * @param {number} [tokenId] The token id
   * @returns The sapling ID for the token in the map contract storage
   */
  getSaplingId = async (contract?: string, tokenId?: number) => {
    // Create cache key
    const cacheKey = contract
      ? `${contract}${tokenId !== undefined ? `:${tokenId}` : ''}`
      : 'tez';

    // Check cache first and return the promise if it exists
    if (this.saplingIdCache.has(cacheKey)) {
      return this.saplingIdCache.get(cacheKey)!;
    }

    // Create and cache the promise to prevent duplicate concurrent requests
    const saplingIdPromise = (async () => {
      try {
        // Fetch map contract storage using TzKT API
        const contractStorage: {
          tez: number;
          token_fa_1_2: Record<string, number>;
          token_fa_2: Array<{
            key: { address: string; nat: string };
            value: number;
          }>;
        } = await fetch(
          `${this.tzktBaseUrl}/v1/contracts/${this.shieldBridgeContractAddress}/storage`,
        ).then((res) => {
          if (!res.ok) {
            throw new Error(
              `Failed to fetch contract storage: ${res.status} ${res.statusText}`,
            );
          }
          return res.json();
        });

        let saplingId: number | undefined;

        if (contract) {
          if (tokenId !== undefined) {
            // FA2 token - find in token_fa_2 array
            saplingId = contractStorage.token_fa_2.find(
              (token) =>
                token.key.address === contract &&
                token.key.nat === `${tokenId}`,
            )?.value;
          } else {
            // FA1.2 token - lookup in token_fa_1_2 map
            saplingId = contractStorage.token_fa_1_2[contract];
          }
        } else {
          // TEZ - direct storage field
          saplingId = contractStorage.tez;
        }

        return saplingId;
      } catch (error: unknown) {
        // Remove from cache on error so it can be retried
        this.saplingIdCache.delete(cacheKey);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to get sapling ID for ${cacheKey}: ${message}`);
      }
    })();

    // Cache the promise immediately before any await
    this.saplingIdCache.set(cacheKey, saplingIdPromise);

    // Don't pin a not-yet-initialized sapling state (undefined) forever: evict
    // it once resolved so a later registration is picked up. A valid sapling ID
    // can be 0, so evict strictly on undefined. The identity guard avoids races.
    saplingIdPromise
      .then((value) => {
        if (
          value === undefined &&
          this.saplingIdCache.get(cacheKey) === saplingIdPromise
        ) {
          this.saplingIdCache.delete(cacheKey);
        }
      })
      .catch(() => {
        // Rejections already evict via the catch above.
      });

    return saplingIdPromise;
  };

  /**
   * @description Get the metadata for the token contract and token id if provided
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The metadata for the token contract and token id if provided
   *
   * @note Uses TzKT API which automatically decodes token metadata from bytes.
   * Taquito RPC returns raw big map structures that require manual decoding.
   */
  getTokenMetadata = async (contract: string, tokenId?: number) => {
    // Create cache key
    const cacheKey = `${contract}${tokenId !== undefined ? `:${tokenId}` : ''}`;

    // Check cache first and return the promise if it exists
    if (this.tokenMetadataCache.has(cacheKey)) {
      return this.tokenMetadataCache.get(cacheKey)!;
    }

    // Create and cache the promise to prevent duplicate concurrent requests
    const metadataPromise = (async () => {
      try {
        // Use TzKT API to get decoded token metadata
        // TzKT automatically decodes metadata bytes and handles TZIP-12/16 standards
        const tokenIdParam =
          tokenId !== undefined ? `&token.tokenId=${tokenId}` : '';
        const response = await fetch(
          `${this.tzktBaseUrl}/v1/tokens?contract=${contract}${tokenIdParam}&limit=1`,
        );
        const tokens = await response.json();

        if (tokens && tokens.length > 0) {
          return tokens[0].metadata;
        }

        return {};
      } catch (error: unknown) {
        // Remove from cache on error so it can be retried
        this.tokenMetadataCache.delete(cacheKey);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to get token metadata for ${cacheKey}: ${message}`,
        );
      }
    })();

    // Cache the promise immediately before any await
    this.tokenMetadataCache.set(cacheKey, metadataPromise);

    return metadataPromise;
  };

  /**
   * @description Get the number of decimals for the token contract and token id if provided
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The number of decimals for the token contract and token id if provided
   */
  getTokenDecimals = async (contract: string, tokenId?: number) => {
    // Create cache key
    const cacheKey = `${contract}${tokenId !== undefined ? `:${tokenId}` : ''}`;

    // Check cache first and return the promise if it exists
    if (this.tokenDecimalsCache.has(cacheKey)) {
      return this.tokenDecimalsCache.get(cacheKey)!;
    }

    // Create and cache the promise to prevent duplicate concurrent requests
    const decimalsPromise = (async () => {
      try {
        const { decimals } = (await this.getTokenMetadata(
          contract,
          tokenId,
        )) as TokenMetadata;
        if (!decimals) {
          throw new Error(
            `Token metadata missing 'decimals' field for ${cacheKey}`,
          );
        }
        const parsed = parseInt(decimals, 10);
        if (Number.isNaN(parsed)) {
          throw new Error(
            `Invalid decimals value "${decimals}" for ${cacheKey}`,
          );
        }
        return parsed;
      } catch (error: unknown) {
        // Remove from cache on error so it can be retried
        this.tokenDecimalsCache.delete(cacheKey);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to get token decimals for ${cacheKey}: ${message}`,
        );
      }
    })();

    // Cache the promise immediately before any await
    this.tokenDecimalsCache.set(cacheKey, decimalsPromise);

    return decimalsPromise;
  };

  /**
   * @description Get the total shielded pool balances across all set contracts
   * @returns The aggregated balances from all individual set contracts
   *
   * @note In the factory architecture, the factory contract itself holds no balances.
   * Each token type has its own set contract that holds the actual assets.
   * This method aggregates balances from all individual set contracts.
   */
  getTotalShieldedSetBalances = async () => {
    // Get all set contracts from the factory
    const setAssets = await this.getAllShieldedAssets();

    // Query balances from each set contract in parallel, isolating errors
    const balanceResults = await Promise.allSettled(
      setAssets.map(async (asset) => {
        const balances: TzKTTokenBalance[] = await fetch(
          `${this.tzktBaseUrl}/v1/tokens/balances?account=${asset.setAddress}&sort.desc=balanceValue&limit=100&offset=0`,
        ).then((res) => res.json());

        return balances.map((token) => {
          let unitAmount: number | string = token.balance as string;
          if (!this.useBaseUnits) {
            const decimals = token.token?.metadata?.decimals;
            if (!decimals) {
              console.warn(
                `[ShieldBridgeSDK] Missing decimals for token at ${asset.setAddress}, using raw balance`,
              );
            }
            unitAmount = new BigNumber(unitAmount)
              .dividedBy(new BigNumber(10).exponentiatedBy(decimals ?? 0))
              .toNumber();
          }
          return {
            ...token,
            balance: unitAmount,
            setAddress: asset.setAddress,
          };
        });
      }),
    );

    return balanceResults
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          typeof r extends PromiseFulfilledResult<infer T> ? T : never
        > => r.status === 'fulfilled',
      )
      .flatMap((r) => r.value);
  };

  /**
   * @description Estimate the gas and storage limits for the transaction list of shielding transactions
   * @param {OrderedTransactionList} transactionList The constructed transaction list
   * @returns The estimated gas and storage limits for the transaction list
   */
  estimateShieldTransactionLimits = async (
    transactionList: OrderedTransactionList,
  ) => {
    const contractEstimator = await this.getEstimatorContract(
      this.shieldBridgeContractAddress,
    );

    const batch: [
      ContractMethodObject<Wallet | ContractProvider>,
      { amount?: number | string; mutez?: boolean },
    ][] = [];

    for (let index = 0; index < transactionList.length; index += 1) {
      /**
       * These transactions are not yet formatted for the contract call. The default
       * index transactions can be submitted in a single call with a list of transactions.
       * This is being done to optimize the number of operations in the transaction.
       */
      if (index === OperationIndex.DEFAULT_INDEX) {
        const nonTezTransactions: FactoryTransactionItem[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for (const transaction of transactionList[index]) {
          // amount is only present for tez deposits
          if (transaction.contract) {
            nonTezTransactions.push(transaction);
            // eslint-disable-next-line no-continue
            continue;
          }

          const { amount } = transaction;
          batch.push([
            contractEstimator.methodsObject.default([transaction]),
            {
              amount: amount?.toString(),
              mutez: true,
            },
          ]);
        }
        // If token deposits are present, batch them separately from tez deposits
        if (nonTezTransactions.length) {
          batch.push([
            contractEstimator.methodsObject.default(nonTezTransactions),
            {},
          ]);
        }
      } else {
        // These transactions are already formatted to be included in the batch call
        transactionList[index].forEach((transaction) => {
          batch.push([transaction as ContractMethodObject<Wallet>, {}]);
        });
      }
    }

    const estimateBatch: withKind<TaquitoTransferParams, OpKind.TRANSACTION>[] =
      batch.map(([operation, params = {}]) => ({
        kind: OpKind.TRANSACTION,
        // @ts-expect-error string is an acceptable type for amount
        ...operation.toTransferParams(params),
      }));

    return this.tezosClient.estimate.batch(estimateBatch);
  };

  /**
   * @description Submit sapling deposits/shielding transactions
   * @param {SaplingDeposits} saplingDeposits Sapling deposits/shielding transactions to be submitted
   * @param {number} saplingDeposits.amount The amount to be shielded
   * @param {string[]} saplingDeposits.saplingTransactions The sapling transactions to be submitted
   * @param {string} [saplingDeposits.contract] The token contract address
   * @param {number} [saplingDeposits.tokenId] The token id
   * @param {string} [saplingDeposits.owner] The shielded address to apply the shielded tokens
   * @returns The confirmation of the submitted sapling deposits/shielding transactions
   */
  submitSaplingShieldTransaction = async (
    saplingDeposits: SaplingDeposits[],
    callbacks?: TransactionProgressCallbacks,
  ) => {
    // V2: Call Set contracts directly (bypasses Factory for efficiency)
    if (this.contractArchitecture === '2') {
      return this.submitSaplingShieldTransactionV2(saplingDeposits, callbacks);
    }
    // V1: Route through map contract (legacy)
    const dappContract = await this.getContract(
      this.shieldBridgeContractAddress,
    );

    const transactionList: OrderedTransactionList = [[], [], [], []];

    // eslint-disable-next-line no-restricted-syntax
    for (const saplingDeposit of saplingDeposits) {
      const { owner, amount, saplingTransactions, contract, tokenId } =
        saplingDeposit;

      if (contract) {
        // eslint-disable-next-line no-await-in-loop
        const tokenContract = await this.getContract(contract);
        // V1: The map contract itself is the operator/spender for token approvals
        const operator = this.shieldBridgeContractAddress;

        if (tokenId !== undefined) {
          // FA2 update_operators add_operator
          transactionList[OperationIndex.UPDATE_OPERATORS_ADD_INDEX].push(
            tokenContract.methodsObject.update_operators([
              {
                add_operator: {
                  owner,
                  operator,
                  token_id: tokenId,
                },
              },
            ]),
          );
          // Sapling State Contract default
          transactionList[OperationIndex.DEFAULT_INDEX].push({
            txns: saplingTransactions,
            contract,
            token_id: tokenId,
          });
          // FA2 update_operators remove_operator
          transactionList[OperationIndex.UPDATE_OPERATORS_REMOVE_INDEX].push(
            tokenContract.methodsObject.update_operators([
              {
                remove_operator: {
                  owner,
                  operator,
                  token_id: tokenId,
                },
              },
            ]),
          );
        } else {
          // FA1.2 approve
          transactionList[OperationIndex.APPROVE_INDEX].push(
            tokenContract.methodsObject.approve({
              value: amount,
              spender: operator,
            }),
          );
          // Sapling State Contract default
          transactionList[OperationIndex.DEFAULT_INDEX].push({
            txns: saplingTransactions,
            contract,
          });
        }
      } else {
        // Tez transaction
        transactionList[OperationIndex.DEFAULT_INDEX].push({
          txns: saplingTransactions,
          amount,
        });
      }
    }

    const estimates =
      await this.estimateShieldTransactionLimits(transactionList);

    const batch = this.tezosClient.wallet.batch();

    for (let index = 0; index < transactionList.length; index += 1) {
      /**
       * These transactions are not yet formatted for the contract call. The default
       * index transactions can be submitted in a single call with a list of transactions.
       * This is being done to optimize the number of operations in the transaction.
       */
      if (index === OperationIndex.DEFAULT_INDEX) {
        const nonTezTransactions: FactoryTransactionItem[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for (const transaction of transactionList[index]) {
          const { amount } = transaction;
          // amount is only present for tez deposits
          if (transaction.contract) {
            nonTezTransactions.push(transaction);
            // eslint-disable-next-line no-continue
            continue;
          }

          const estimate = estimates.shift();
          batch.withContractCall(
            dappContract.methodsObject.default([transaction]),
            {
              // @ts-expect-error string is an acceptable type for amount
              amount,
              mutez: true,
              gasLimit: estimate!.gasLimit,
              storageLimit: estimate!.storageLimit,
              fee: estimate!.suggestedFeeMutez,
            },
          );
        }
        // If token deposits are present, batch them separately from tez deposits
        if (nonTezTransactions.length) {
          const estimate = estimates.shift();
          batch.withContractCall(
            dappContract.methodsObject.default(nonTezTransactions),
            {
              gasLimit: estimate!.gasLimit,
              storageLimit: estimate!.storageLimit,
              fee: estimate!.suggestedFeeMutez,
            },
          );
        }
      } else {
        // These transactions are already formatted to be included in the batch call
        transactionList[index].forEach((transaction) => {
          estimates.shift();
          batch.withContractCall(transaction as ContractMethodObject<Wallet>);
        });
      }
    }

    callbacks?.onSigning?.();
    return batch.send().then(async (op) => {
      callbacks?.onSubmitting?.({ opHash: op.opHash });
      const confirmation = await this.awaitConfirmation(op);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callbacks?.onConfirmed?.({
        opHash: op.opHash,
        block: confirmation as any,
      });
      return { ...confirmation, opHash: op.opHash };
    });
  };

  /**
   * @description V2: Submit sapling shield transactions by calling Set contracts directly.
   * Bypasses the Factory contract for maximum gas efficiency:
   *   - FA1.2: approve(Set) → Set.default(txns)
   *   - FA2: add_operator(Set) → Set.default(txns) → remove_operator(Set)
   *   - Tez: TezSet.default(txns) with XTZ amount
   */
  private submitSaplingShieldTransactionV2 = async (
    saplingDeposits: SaplingDeposits[],
    callbacks?: TransactionProgressCallbacks,
  ) => {
    const ops: {
      method: ContractMethodObject<Wallet>;
      params?: { amount?: number | string; mutez?: boolean };
    }[] = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const saplingDeposit of saplingDeposits) {
      const { owner, amount, saplingTransactions, contract, tokenId } =
        saplingDeposit;

      if (contract) {
        // eslint-disable-next-line no-await-in-loop
        const tokenContract = await this.getContract(contract);
        // eslint-disable-next-line no-await-in-loop
        const setAddress = await this.getSetAddress(contract, tokenId);

        if (!setAddress) {
          throw new Error(
            `Sapling set address not found for contract ${contract} and tokenId ${tokenId}`,
          );
        }

        // eslint-disable-next-line no-await-in-loop
        const setContract = await this.getContract(setAddress);

        if (tokenId !== undefined) {
          // FA2: add_operator → Set.default → remove_operator
          ops.push({
            method: tokenContract.methodsObject.update_operators([
              {
                add_operator: {
                  owner,
                  operator: setAddress,
                  token_id: tokenId,
                },
              },
            ]),
          });
          ops.push({
            method: setContract.methodsObject.default(saplingTransactions),
          });
          ops.push({
            method: tokenContract.methodsObject.update_operators([
              {
                remove_operator: {
                  owner,
                  operator: setAddress,
                  token_id: tokenId,
                },
              },
            ]),
          });
        } else {
          // FA1.2: approve → Set.default
          ops.push({
            method: tokenContract.methodsObject.approve({
              value: amount.toString(),
              spender: setAddress,
            }),
          });
          ops.push({
            method: setContract.methodsObject.default(saplingTransactions),
          });
        }
      } else {
        // Tez: call Tez Set directly with amount
        // eslint-disable-next-line no-await-in-loop
        const setAddress = await this.getSetAddress();
        if (!setAddress) {
          throw new Error('Tez sapling set address not found');
        }
        // eslint-disable-next-line no-await-in-loop
        const setContract = await this.getContract(setAddress);
        ops.push({
          method: setContract.methodsObject.default(saplingTransactions),
          params: { amount: amount.toString(), mutez: true },
        });
      }
    }

    // Estimate all operations
    const estimateBatch: withKind<TaquitoTransferParams, OpKind.TRANSACTION>[] =
      ops.map(({ method, params = {} }) => ({
        kind: OpKind.TRANSACTION,
        // @ts-expect-error string is an acceptable type for amount
        ...method.toTransferParams(params),
      }));
    const estimates = await this.tezosClient.estimate.batch(estimateBatch);

    // Build and send batch
    const batch = this.tezosClient.wallet.batch();
    ops.forEach(({ method, params = {} }, i) => {
      const estimate = estimates[i];

      // @ts-expect-error string is an acceptable type for amount
      batch.withContractCall(method, {
        ...params,
        gasLimit: estimate.gasLimit,
        storageLimit: estimate.storageLimit,
        fee: estimate.suggestedFeeMutez,
      });
    });

    callbacks?.onSigning?.();
    return batch.send().then(async (op) => {
      callbacks?.onSubmitting?.({ opHash: op.opHash });
      const confirmation = await this.awaitConfirmation(op);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callbacks?.onConfirmed?.({
        opHash: op.opHash,
        block: confirmation as any,
      });
      return { ...confirmation, opHash: op.opHash };
    });
  };

  /**
   * @description Submit sapling transactions (shared implementation for unshield and transfer)
   * @param {SaplingTransactions} saplingTransactions Sapling transactions to be submitted
   * @param {string[]} saplingTransactions.saplingTransactions The sapling transactions to be submitted
   * @param {string} [saplingTransactions.contract] The token contract address
   * @param {number} [saplingTransactions.tokenId] The token id
   * @returns The confirmation of the submitted sapling transactions
   */
  submitSaplingTransaction = async (
    saplingTransactions: SaplingTransactions[],
    callbacks?: TransactionProgressCallbacks,
  ): Promise<{ block?: BlockResponse; opHash: string }> => {
    // V2: Call Set contracts directly (bypasses Factory)
    if (this.contractArchitecture === '2') {
      return this.submitSaplingTransactionV2(saplingTransactions, callbacks);
    }
    // V1: Route through map contract (legacy)
    const dappContract = await this.getContract(
      this.shieldBridgeContractAddress,
    );

    const dappContractEstimator = await this.getEstimatorContract(
      this.shieldBridgeContractAddress,
    );

    const saplingMethodObject = saplingTransactions.map(
      (saplingTransaction) => ({
        txns: saplingTransaction.saplingTransactions,
        contract: saplingTransaction.contract,
        token_id: saplingTransaction.tokenId,
      }),
    );

    const operation =
      dappContractEstimator.methodsObject.default(saplingMethodObject);

    const estimate = await this.tezosClient.estimate.contractCall(operation);

    callbacks?.onSigning?.();
    return dappContract.methodsObject
      .default(saplingMethodObject)
      .send({
        gasLimit: estimate.gasLimit,
        storageLimit: estimate.storageLimit,
        fee: estimate.suggestedFeeMutez,
      })
      .then(async (op: WalletOperation) => {
        callbacks?.onSubmitting?.({ opHash: op.opHash });
        const confirmation = await this.awaitConfirmation(op);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callbacks?.onConfirmed?.({
          opHash: op.opHash,
          block: confirmation as any,
        });
        return { ...confirmation, opHash: op.opHash };
      });
  };

  /**
   * @description V2: Submit sapling transactions (unshield/transfer) by calling Set contracts directly.
   * No token approvals needed — unshield sends from pool, transfer is state-only.
   */
  private submitSaplingTransactionV2 = async (
    saplingTransactions: SaplingTransactions[],
    callbacks?: TransactionProgressCallbacks,
  ): Promise<{ block?: BlockResponse; opHash: string }> => {
    const ops: {
      method: ContractMethodObject<Wallet>;
    }[] = [];

    // eslint-disable-next-line no-restricted-syntax
    for (const saplingTx of saplingTransactions) {
      // eslint-disable-next-line no-await-in-loop
      const setAddress = await this.getSetAddress(
        saplingTx.contract,
        saplingTx.tokenId,
      );
      if (!setAddress) {
        const tokenInfo = saplingTx.contract
          ? `contract ${saplingTx.contract}${saplingTx.tokenId !== undefined ? ` tokenId ${saplingTx.tokenId}` : ''}`
          : 'tez';
        throw new Error(`Sapling set not found for ${tokenInfo}`);
      }
      // eslint-disable-next-line no-await-in-loop
      const setContract = await this.getContract(setAddress);
      ops.push({
        method: setContract.methodsObject.default(
          saplingTx.saplingTransactions,
        ),
      });
    }

    // Estimate all operations
    const estimateBatch: withKind<TaquitoTransferParams, OpKind.TRANSACTION>[] =
      ops.map(({ method }) => ({
        kind: OpKind.TRANSACTION,
        ...method.toTransferParams(),
      }));
    const estimates = await this.tezosClient.estimate.batch(estimateBatch);

    // Build and send batch
    const batch = this.tezosClient.wallet.batch();
    ops.forEach(({ method }, i) => {
      const estimate = estimates[i];

      batch.withContractCall(method, {
        gasLimit: estimate.gasLimit,
        storageLimit: estimate.storageLimit,
        fee: estimate.suggestedFeeMutez,
      });
    });

    callbacks?.onSigning?.();
    return batch.send().then(async (op: WalletOperation) => {
      callbacks?.onSubmitting?.({ opHash: op.opHash });
      const confirmation = await this.awaitConfirmation(op);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callbacks?.onConfirmed?.({
        opHash: op.opHash,
        block: confirmation as any,
      });
      return { ...confirmation, opHash: op.opHash };
    });
  };

  /**
   * @description Submit sapling withdrawals/unshielding transactions
   * @param {SaplingTransactions} saplingWithdrawals Sapling withdrawals/unshielding transactions to be submitted
   * @param {string[]} saplingWithdrawals.saplingTransactions The sapling transactions to be submitted
   * @param {string} [saplingWithdrawals.contract] The token contract address
   * @param {number} [saplingWithdrawals.tokenId] The token id
   * @returns The confirmation of the submitted sapling withdrawals/unshielding transactions
   */
  submitSaplingUnshieldTransaction = async (
    saplingWithdrawals: SaplingTransactions[],
    callbacks?: TransactionProgressCallbacks,
  ) => this.submitSaplingTransaction(saplingWithdrawals, callbacks);

  /**
   * @description Submit sapling transfers transactions
   * @param {SaplingTransactions} saplingTransfers Sapling transfers to be submitted
   * @param {string[]} saplingTransfers.saplingTransactions The sapling transactions to be submitted
   * @param {string} [saplingTransfers.contract] The token contract address
   * @param {number} [saplingTransfers.tokenId] The token id
   * @returns The confirmation of the submitted sapling transfers
   */
  submitSaplingTransferTransaction = async (
    saplingTransfers: SaplingTransactions[],
    callbacks?: TransactionProgressCallbacks,
  ) => this.submitSaplingTransaction(saplingTransfers, callbacks);

  /**
   * @description Construct the sapling parameters for the shielded transaction
   * @param shieldParam The sapling shielding parameters
   * @param {number} shieldParam.amount The amount to be shielded
   * @param {string} [shieldParam.shieldedAddress] The shielded address to apply the shielded tokens
   * @param {string} [shieldParam.contract] The token contract address
   * @param {number} [shieldParam.tokenId] The token id
   * @param {string} [shieldParam.memo] The memo to be included in the sapling transaction
   * @returns The sapling parameters for the shielded transaction
   */
  constructShieldTokenParams = async (shieldParam: ShieldParams) => {
    const { amount, shieldedAddress, contract, tokenId, memo } = shieldParam;

    // Validate amount
    validateAmount(amount, 'Shield amount');

    return this.withWorker(
      async (saplingWorker, tokenDecimals) => {
        let unitAmount: string = amount.toString();
        if (!this.useBaseUnits) {
          unitAmount = toBaseUnits(amount, tokenDecimals);
        }

        let to = shieldedAddress;
        // If no shielded address is provided, default to the loaded sapling payment address
        if (!to) {
          const saplingPaymentAddress = await saplingWorker.getPaymentAddress();
          to = saplingPaymentAddress.address;
        }
        const saplingTxn = await saplingWorker.prepareShieldedTransaction([
          {
            to,
            amount: unitAmount,
            memo,
            mutez: true,
          },
        ]);

        const owner = await this.tezosClient.wallet.pkh();

        return {
          saplingTransactions: [saplingTxn].filter(
            (t): t is string => t != null,
          ),
          owner,
          amount: unitAmount,
          contract,
          tokenId,
        } satisfies SaplingDeposits;
      },
      contract,
      tokenId,
    );
  };

  /**
   * @description Shield the specified amount of unshielded tokens to the sapling address
   * @param {ShieldParams} shieldParams Sapling shielding parameters to be constructed into sapling transactions
   * @param {number} shieldParams.amount The amount to be shielded
   * @param {string} [shieldParams.shieldedAddress] The shielded address to apply the shielded tokens
   * @param {string} [shieldParams.contract] The token contract address
   * @param {number} [shieldParams.tokenId] The token id
   * @param {string} [shieldParams.memo] The memo to be included in the sapling transaction
   * @param {TransactionProgressCallbacks} [callbacks] Optional callbacks for operation progress updates
   * @returns The confirmation of the submitted sapling shielding transactions
   * @throws {Error} If called in view-only mode (with a viewing key)
   */
  shield = async (
    shieldParams: ShieldParams[],
    callbacks?: TransactionProgressCallbacks,
  ) => {
    if (this.isViewOnlyMode) {
      throw new Error(
        'Cannot shield tokens in view-only mode. A spending key is required for transaction operations. ' +
          'Initialize the SDK with saplingSecret or saplingMnemonic instead of saplingViewingKey.',
      );
    }

    this.operationsInFlight += 1;
    try {
      let contractParams: SaplingDeposits[] = [];

      callbacks?.onGenerating?.(shieldParams);
      if (this.parallelThreads) {
        const shieldParamPromises = shieldParams.map((shieldParam) =>
          this.constructShieldTokenParams(shieldParam),
        );
        contractParams = await Promise.all(shieldParamPromises);
      } else {
        for (let i = 0; i < shieldParams.length; i += 1) {
          const shieldParam = shieldParams[i];
          const contractParam =
            // eslint-disable-next-line no-await-in-loop
            await this.constructShieldTokenParams(shieldParam);
          contractParams.push(contractParam);
        }
      }

      return await this.submitSaplingShieldTransaction(
        contractParams,
        callbacks,
      );
    } finally {
      this.operationsInFlight -= 1;
    }
  };

  /**
   * @description Construct the sapling parameters for the unshielded transaction
   * @param unshieldParam The sapling unshielding parameters
   * @param {number} unshieldParam.amount The amount to be unshielded
   * @param {string} [unshieldParam.unshieldedAddress] The unshielded address to apply the unshielded tokens
   * @param {string} [unshieldParam.contract] The token contract address
   * @param {number} [unshieldParam.tokenId] The token id
   * @returns The sapling parameters for the unshielded transaction
   */
  constructUnshieldTokenParams = async (unshieldParam: UnshieldParams) => {
    const { amount, unshieldedAddress, contract, tokenId } = unshieldParam;

    // Validate amount
    validateAmount(amount, 'Unshield amount');

    return this.withWorker(
      async (saplingWorker, tokenDecimals) => {
        let unitAmount: string = amount.toString();
        if (!this.useBaseUnits) {
          unitAmount = toBaseUnits(amount, tokenDecimals);
        }

        let to = unshieldedAddress;
        // If no unshielded address is provided, default to the wallet public key hash
        if (!to) {
          to = await this.tezosClient.wallet.pkh();
        }
        const saplingTxn = await saplingWorker.prepareUnshieldedTransaction({
          to,
          amount: unitAmount,
          mutez: true,
        });

        return {
          saplingTransactions: [saplingTxn].filter(
            (t): t is string => t != null,
          ),
          contract,
          tokenId,
        } satisfies SaplingTransactions;
      },
      contract,
      tokenId,
    );
  };

  /**
   * @description Unshield the specified amount of shielded tokens from the sapling address
   * @param {UnshieldParams} unshieldParams Sapling unshielding parameters to be constructed into sapling transactions
   * @param {number} unshieldParams.amount The amount to be unshielded
   * @param {string} [unshieldParams.unshieldedAddress] The unshielded address to apply the unshielded tokens
   * @param {string} [unshieldParams.contract] The token contract address
   * @param {number} [unshieldParams.tokenId] The token id
   * @param {TransactionProgressCallbacks} [callbacks] Optional callbacks for operation progress updates
   * @returns The confirmation of the submitted sapling unshielding transactions
   * @throws {Error} If called in view-only mode (with a viewing key)
   */
  unshield = async (
    unshieldParams: UnshieldParams[],
    callbacks?: TransactionProgressCallbacks,
  ) => {
    if (this.isViewOnlyMode) {
      throw new Error(
        'Cannot unshield tokens in view-only mode. A spending key is required for transaction operations. ' +
          'Initialize the SDK with saplingSecret or saplingMnemonic instead of saplingViewingKey.',
      );
    }

    this.operationsInFlight += 1;
    try {
      let contractParams: SaplingTransactions[] = [];

      callbacks?.onGenerating?.(unshieldParams);
      if (this.parallelThreads) {
        const unshieldParamPromises = unshieldParams.map((unshieldParam) =>
          this.constructUnshieldTokenParams(unshieldParam),
        );
        contractParams = await Promise.all(unshieldParamPromises);
      } else {
        for (let i = 0; i < unshieldParams.length; i += 1) {
          const unshieldParam = unshieldParams[i];
          const contractParam =
            // eslint-disable-next-line no-await-in-loop
            await this.constructUnshieldTokenParams(unshieldParam);
          contractParams.push(contractParam);
        }
      }

      return await this.submitSaplingUnshieldTransaction(
        contractParams,
        callbacks,
      );
    } finally {
      this.operationsInFlight -= 1;
    }
  };

  /**
   * @description Construct the sapling parameters for the transfer transaction
   * @param transferParam The sapling transfer parameters
   * @param {string} [transferParam.contract] The token contract address
   * @param {number} [transferParam.tokenId] The token id
   * @param {object} transferParam.transfers The transfers to be made
   * @returns The sapling parameters for the transfer transaction
   */
  constructTransferTokenParams = async (transferParam: TransferParams) => {
    const { contract, tokenId, transfers } = transferParam;

    // Validate inputs
    if (!transfers || !Array.isArray(transfers) || transfers.length === 0) {
      throw new Error('Transfers array must not be empty');
    }
    transfers.forEach((transfer, index) => {
      if (!transfer.to || typeof transfer.to !== 'string') {
        throw new Error(
          `Transfer[${index}] recipient address must be a valid string`,
        );
      }
      validateAmount(transfer.amount, `Transfer[${index}] amount`);
    });

    return this.withWorker(
      async (saplingWorker, tokenDecimals) => {
        const saplingTransfers = transfers.map(({ amount, to, memo }) => {
          let unitAmount: string = amount.toString();

          if (!this.useBaseUnits) {
            unitAmount = toBaseUnits(amount, tokenDecimals);
          }

          return {
            to,
            amount: unitAmount,
            memo,
            mutez: true,
          };
        });

        const saplingTxn =
          await saplingWorker.prepareSaplingTransaction(saplingTransfers);

        return {
          saplingTransactions: [saplingTxn].filter(
            (t): t is string => t != null,
          ),
          contract,
          tokenId,
        } satisfies SaplingTransactions;
      },
      contract,
      tokenId,
    );
  };

  /**
   * @description Transfer the specified amount of shielded tokens to the specified shielded address
   * @param {TransferParams[]} transferParams Sapling transfer parameters to be constructed into sapling transactions
   * @param {string} [transferParams.contract] The token contract address
   * @param {number} [transferParams.tokenId] The token id
   * @param {object} transferParams.transfers The transfers to be made
   * @param {TransactionProgressCallbacks} [callbacks] Optional callbacks for operation progress updates
   * @returns The confirmation of the submitted sapling transfer transactions
   * @throws {Error} If called in view-only mode (with a viewing key)
   */
  transfer = async (
    transferParams: TransferParams[],
    callbacks?: TransactionProgressCallbacks,
  ) => {
    if (this.isViewOnlyMode) {
      throw new Error(
        'Cannot transfer tokens in view-only mode. A spending key is required for transaction operations. ' +
          'Initialize the SDK with saplingSecret or saplingMnemonic instead of saplingViewingKey.',
      );
    }

    this.operationsInFlight += 1;
    try {
      let contractParams: SaplingTransactions[] = [];

      callbacks?.onGenerating?.(transferParams);
      if (this.parallelThreads) {
        const unshieldParamPromises = transferParams.map((transferParam) =>
          this.constructTransferTokenParams(transferParam),
        );
        contractParams = await Promise.all(unshieldParamPromises);
      } else {
        for (let i = 0; i < transferParams.length; i += 1) {
          const transferParam = transferParams[i];
          const contractParam =
            // eslint-disable-next-line no-await-in-loop
            await this.constructTransferTokenParams(transferParam);
          contractParams.push(contractParam);
        }
      }

      return await this.submitSaplingTransferTransaction(
        contractParams,
        callbacks,
      );
    } finally {
      this.operationsInFlight -= 1;
    }
  };

  /**
   * @description Get the shielded sapling token balance for the currently loaded shielded address
   * @param {SaplingTokenInfo} saplingTokenInfo The sapling token information
   * @param {string} [saplingTokenInfo.contract] The token contract address
   * @param {number} [saplingTokenInfo.tokenId] The token id
   * @param {string} [saplingTokenInfo.setAddress] The set contract address
   * @returns The shielded sapling token balance for the currently loaded shielded address
   */
  getShieldedBalance = async ({
    contract,
    tokenId,
    setAddress,
  }: SaplingTokenInfo): Promise<number> =>
    this.withWorker(
      async (saplingWorker, tokenDecimals) => {
        const balance = (await saplingWorker.getSaplingBalance()) as number;

        if (this.useBaseUnits) {
          return balance;
        }

        return new BigNumber(balance)
          .dividedBy(new BigNumber(10).exponentiatedBy(tokenDecimals))
          .toNumber();
      },
      contract,
      tokenId,
      setAddress,
    );

  /**
   * @description Evict this account's incremental balance cache (the v2 decrypt cache, which
   * holds decrypted notes). Call this when forgetting/locking an account so no decrypted data is
   * left at rest. No-op when the balance cache is disabled or unavailable.
   */
  clearShieldedBalanceCache = async (): Promise<void> => {
    await this.ready;
    await this.withWorker(async (saplingWorker) => {
      await (
        saplingWorker as unknown as {
          clearShieldedBalanceCache: () => Promise<void>;
        }
      ).clearShieldedBalanceCache();
    });
  };

  // ---------------------------------------------------------------------------
  // Factory contract on-chain view methods (V2 only)
  // ---------------------------------------------------------------------------

  /**
   * @description Get the Tez set contract address from the factory
   * @returns The address of the Tez sapling set contract
   * @throws If the factory contract doesn't have a Tez set or if not using V2 architecture
   */
  getTezSetAddress = async (): Promise<string> => {
    if (this.contractArchitecture !== '2') {
      throw new Error('Factory views are only available with V2 architecture');
    }
    const factoryContract = await this.getEstimatorContract(
      this.shieldBridgeContractAddress,
    );
    const tezSetAddress = await factoryContract.contractViews
      .get_tez_set()
      .executeView({ viewCaller: this.shieldBridgeContractAddress });
    return tezSetAddress;
  };

  /**
   * @description Get the FA1.2 set contract address for a given token from the factory
   * @param tokenContract The FA1.2 token contract address
   * @returns The address of the FA1.2 sapling set contract, or undefined if not registered
   * @throws If not using V2 architecture
   */
  getFA12SetAddress = async (
    tokenContract: string,
  ): Promise<string | undefined> => {
    if (this.contractArchitecture !== '2') {
      throw new Error('Factory views are only available with V2 architecture');
    }
    const factoryContract = await this.getEstimatorContract(
      this.shieldBridgeContractAddress,
    );
    const result = await factoryContract.contractViews
      .get_fa1_2_set(tokenContract)
      .executeView({ viewCaller: this.shieldBridgeContractAddress });
    // On-chain view returns option<address> — Taquito represents None as undefined
    return result ?? undefined;
  };

  /**
   * @description Get the FA2 set contract address for a given token and token ID from the factory
   * @param tokenContract The FA2 token contract address
   * @param tokenId The FA2 token ID
   * @returns The address of the FA2 sapling set contract, or undefined if not registered
   * @throws If not using V2 architecture
   */
  getFA2SetAddress = async (
    tokenContract: string,
    tokenId: number,
  ): Promise<string | undefined> => {
    if (this.contractArchitecture !== '2') {
      throw new Error('Factory views are only available with V2 architecture');
    }
    const factoryContract = await this.getEstimatorContract(
      this.shieldBridgeContractAddress,
    );
    const result = await factoryContract.contractViews
      .get_fa2_set({ contract: tokenContract, token_id: tokenId })
      .executeView({ viewCaller: this.shieldBridgeContractAddress });
    // On-chain view returns option<address> — Taquito represents None as undefined
    return result ?? undefined;
  };

  /**
   * @description Check if a set contract address was deployed by this factory
   * @param setAddress The set contract address to verify
   * @returns true if the address is a registered set contract deployed by this factory
   * @throws If not using V2 architecture
   */
  isRegisteredSet = async (setAddress: string): Promise<boolean> => {
    if (this.contractArchitecture !== '2') {
      throw new Error('Factory views are only available with V2 architecture');
    }
    const factoryContract = await this.getEstimatorContract(
      this.shieldBridgeContractAddress,
    );
    return factoryContract.contractViews
      .is_registered_set(setAddress)
      .executeView({ viewCaller: this.shieldBridgeContractAddress });
  };

  /**
   * @description Get all the shielded sapling tokens
   * @param includeMetadata Include the metadata for the shielded sapling tokens
   * @returns The shielded sapling tokens with their set contract addresses
   *
   * @note This method uses TzKT API to enumerate big maps in the factory storage.
   * For individual token lookups, use getSetAddress() which uses RPC directly.
   * Big maps cannot be enumerated via RPC without knowing the keys.
   */
  getAllShieldedAssets = async (
    includeMetadata: boolean = false,
  ): Promise<ShieldedAssetInfo[]> => {
    // Get factory storage to retrieve big map IDs
    const factoryContract = await this.getEstimatorContract(
      this.shieldBridgeContractAddress,
    );
    const factoryStorage = await factoryContract.storage<FactoryStorage>();

    const setAddresses: ShieldedAssetInfo[] = [];

    // Add TEZ set if it exists
    const tezAddress = factoryStorage.tez || undefined;
    if (tezAddress) {
      setAddresses.push({
        setAddress: tezAddress,
      });
      // Cache tez set address
      this.setAddressCache.set('tez', Promise.resolve(tezAddress));
    }

    // Enumerate FA2 and FA1.2 token sets from big maps in parallel
    const fa2BigMapId = factoryStorage.token_fa_2;
    const fa12BigMapId = factoryStorage.token_fa_1_2;

    const [fa2Keys, fa12Keys] = await Promise.all([
      fetch(
        `${this.tzktBaseUrl}/v1/bigmaps/${fa2BigMapId}/keys?active=true`,
      ).then((res) => res.json()) as Promise<
        Array<{ key: { address: string; nat: string }; value: string }>
      >,
      fetch(
        `${this.tzktBaseUrl}/v1/bigmaps/${fa12BigMapId}/keys?active=true`,
      ).then((res) => res.json()) as Promise<
        Array<{ key: string; value: string }>
      >,
    ]);

    fa2Keys.forEach(({ key, value }) => {
      const tokenId = parseInt(key.nat, 10);
      setAddresses.push({
        setAddress: value,
        contract: key.address,
        tokenId,
      });

      // Cache FA2 token set address
      const cacheKey = `${key.address}:${tokenId}`;
      this.setAddressCache.set(cacheKey, Promise.resolve(value));
    });

    fa12Keys.forEach(({ key: contract, value: setAddress }) => {
      setAddresses.push({ setAddress, contract });

      // Cache FA1.2 token set address
      this.setAddressCache.set(contract, Promise.resolve(setAddress));
    });

    if (!includeMetadata) {
      return setAddresses;
    }

    const withMetadata = await Promise.all(
      setAddresses.map(async (asset) => {
        if (asset.contract) {
          try {
            const tokenMetadata = await this.getTokenMetadata(
              asset.contract,
              asset.tokenId,
            );
            return { ...asset, metadata: tokenMetadata };
          } catch {
            // Gracefully degrade — one token's missing metadata shouldn't break the list
            return { ...asset, metadata: undefined };
          }
        }
        return asset;
      }),
    );

    return withMetadata;
  };

  /**
   * @description Get the shielded sapling token balances for all the sapling tokens
   * @returns The shielded sapling token balances for all the sapling tokens
   */
  getAllShieldedBalances = async () => {
    const setAssets = await this.getAllShieldedAssets();

    if (this.parallelThreads) {
      // Parallel: query all balances concurrently
      const results = await Promise.all(
        setAssets.map(async (asset) => {
          const balance = await this.getShieldedBalance(asset);
          return { ...asset, balance };
        }),
      );
      return results;
    }

    // Sequential: query balances one at a time
    const balances: {
      setAddress: string;
      contract?: string;
      tokenId?: number;
      balance: number;
    }[] = [];

    for (let i = 0; i < setAssets.length; i += 1) {
      const asset = setAssets[i];
      // eslint-disable-next-line no-await-in-loop
      const balance = await this.getShieldedBalance(asset);
      balances.push({ ...asset, balance });
    }

    return balances;
  };

  /**
   * @description Get the shielded incoming and outgoing transactions for the specified sapling contract and token id
   * @param {string} [contract] Sapling contract address
   * @param {number} [tokenId] Token id
   * @returns The shielded incoming and outgoing transactions for the specified sapling contract and token id
   */
  getShieldedTransactions = async (contract?: string, tokenId?: number) =>
    this.withWorker(
      async (saplingWorker, tokenDecimals) => {
        const transactions = await saplingWorker.getSaplingTransactions();

        return {
          incoming: transactions.incoming.map((transaction) => {
            if (this.useBaseUnits) {
              return transaction;
            }
            const value = new BigNumber(transaction.value)
              .dividedBy(new BigNumber(10).exponentiatedBy(tokenDecimals))
              .toNumber();
            return { ...transaction, value };
          }),
          outgoing: transactions.outgoing.map((transaction) => {
            if (this.useBaseUnits) {
              return transaction;
            }
            const value = new BigNumber(transaction.value)
              .dividedBy(new BigNumber(10).exponentiatedBy(tokenDecimals))
              .toNumber();
            return { ...transaction, value };
          }),
        };
      },
      contract,
      tokenId,
    );

  /**
   * @description Get the sapling payment address of the currently loaded sapling key
   * @returns The sapling payment address
   */
  getShieldedAddress = async (): Promise<string> => {
    // Deterministic in the loaded key — derive once and reuse.
    if (this.shieldedAddressPromise) {
      return this.shieldedAddressPromise;
    }

    const addressPromise = (async () => {
      // Generating a shielded address doesn't require fetching the set address
      // or loading blockchain state - we just need the sapling secret/mnemonic
      await this.ready;
      let { saplingWorker } = this;
      let poolEntry: PoolEntry | null = null;
      if (this.workerPool) {
        poolEntry = await this.workerPool.checkout();
        saplingWorker = poolEntry.worker;
      }

      try {
        const { sk, skType } = this.getSaplingKeyInfo();

        // Load just the sapling secret without contract state
        // Use a dummy contract address since we're only generating the address
        await saplingWorker.loadSaplingSecret({
          sk,
          skType,
          saplingDetails: {
            contractAddress: 'KT1Dummy', // Dummy address - not used for address generation
            memoSize: 8,
          },
          rpcUrl: this.tezosClient.rpc.getRpcUrl(),
        });

        const saplingPaymentAddress = await saplingWorker.getPaymentAddress();
        return saplingPaymentAddress.address;
      } finally {
        if (poolEntry) {
          this.workerPool?.release(poolEntry);
        }
      }
    })();

    // Keep retryable on failure (mirrors the cache delete-on-error pattern).
    addressPromise.catch(() => {
      if (this.shieldedAddressPromise === addressPromise) {
        this.shieldedAddressPromise = undefined;
      }
    });

    this.shieldedAddressPromise = addressPromise;
    return addressPromise;
  };

  /**
   * Switch contract architecture without re-initializing sapling keys.
   *
   * This allows seamless migration between V1 (Map) and V2 (Factory) contracts
   * while preserving the user's sapling account. The shielded address remains
   * the same since it's derived from the mnemonic, not the contract.
   *
   * @param architecture - '1' for Map (legacy), '2' for Factory (recommended)
   * @param contractAddress - Optional custom contract address override
   *
   * @example
   * ```typescript
   * // Switch to V1 to access legacy funds
   * sdk.switchArchitecture('1');
   * await sdk.getShieldedBalance('V1_CONTRACT_ADDRESS');
   *
   * // Switch back to V2 for new transactions
   * sdk.switchArchitecture('2');
   * ```
   */
  switchArchitecture = (
    architecture: ContractArchitecture,
    contractAddress?: string,
  ): void => {
    // Guard against switching while operations are in flight
    if (this.operationsInFlight > 0) {
      throw new Error(
        `Cannot switch architecture while ${this.operationsInFlight} operation(s) are in flight. ` +
          'Wait for all pending operations to complete before switching.',
      );
    }

    // Update architecture setting
    this.contractArchitecture = architecture;

    // Update contract address
    if (contractAddress) {
      this.shieldBridgeContractAddress = contractAddress;
    } else if (architecture === '1') {
      this.shieldBridgeContractAddress = saplingMapContract[this.network];
    } else {
      this.shieldBridgeContractAddress =
        shieldBridgeContractAddresses[this.network];
    }

    // Clear architecture-specific caches. Set addresses (V2) and sapling IDs
    // (V1) are resolved against the now-changed contract, so their caches must
    // be dropped or they'd return stale promises that never refetch. The
    // factory storage snapshot is likewise architecture-bound. Token decimals
    // and metadata are keyed on the token contract (architecture-independent)
    // and are deliberately preserved.
    this.walletContractCache.clear();
    this.estimatorContractCache.clear();
    this.setAddressCache.clear();
    this.saplingIdCache.clear();
    this.factoryStoragePromise = null;

    console.log(
      `[ShieldBridgeSDK] Switched to ${architecture === '1' ? 'V1 (Map)' : 'V2 (Factory)'}: ${this.shieldBridgeContractAddress}`,
    );
  };

  /**
   * Get the current contract architecture version.
   *
   * @returns '1' for Map (legacy) or '2' for Factory (recommended)
   */
  getArchitecture = (): ContractArchitecture => this.contractArchitecture;

  /**
   * @description Export the viewing key for the currently loaded sapling key
   *
   * The viewing key can be used to initialize the SDK in view-only mode, allowing
   * read-only operations (balance queries, transaction history) without exposing
   * the spending key. This is useful for:
   * - Auditing and compliance purposes
   * - Sharing balance visibility without spending ability
   * - Creating monitoring applications
   *
   * @returns The viewing key as a hex string
   * @throws {Error} If no spending key or viewing key is loaded
   *
   * @example
   * // Export viewing key from spending key
   * const viewingKey = await sdk.getViewingKey();
   *
   * // Use it to create a view-only SDK instance
   * const viewOnlySdk = new ShieldBridgeSDK({
   *   client: tezos,
   *   saplingViewingKey: viewingKey
   * });
   *
   * // Now you can query balances without spending ability
   * const balance = await viewOnlySdk.getShieldedBalance({});
   */
  getViewingKey = async (): Promise<string> => {
    // Deterministic in the loaded key — derive once and reuse.
    if (this.viewingKeyPromise) {
      return this.viewingKeyPromise;
    }

    const keyPromise = (async () => {
      // Viewing key is derived purely from the secret/mnemonic — no on-chain state needed.
      // Use a lightweight worker that doesn't load the full sapling blockchain state.
      let { saplingWorker } = this;
      let poolEntry: PoolEntry | null = null;

      if (this.workerPool) {
        poolEntry = await this.workerPool.checkout();
        saplingWorker = poolEntry.worker;
      }

      if (!saplingWorker) {
        throw new Error('Sapling worker not initialized');
      }

      try {
        const { sk, skType } = this.getSaplingKeyInfo();
        await saplingWorker.loadSaplingSecret({
          sk,
          skType,
          // Dummy contract details — viewing key derivation doesn't access the chain
          saplingDetails: {
            contractAddress: this.shieldBridgeContractAddress,
            memoSize: 8,
          },
          rpcUrl: this.tezosClient.rpc.getRpcUrl(),
        });

        return await saplingWorker.getViewingKey();
      } finally {
        if (poolEntry) {
          this.workerPool?.release(poolEntry);
        }
      }
    })();

    // Keep retryable on failure.
    keyPromise.catch(() => {
      if (this.viewingKeyPromise === keyPromise) {
        this.viewingKeyPromise = undefined;
      }
    });

    this.viewingKeyPromise = keyPromise;
    return keyPromise;
  };

  /**
   * @description Clean up all workers and clear caches.
   * Call this when the SDK instance is no longer needed to prevent memory leaks,
   * especially in single-page applications where components may mount/unmount.
   */
  destroy = async () => {
    // Destroy the worker pool first (terminates all pooled workers)
    if (this.workerPool) {
      this.workerPool.destroy();
      this.workerPool = null;
    }

    // Terminate the primary (non-pooled) worker
    try {
      if (this.saplingWorker) {
        this.saplingWorker[Comlink.releaseProxy]();
      }
    } catch {
      // Worker may already be terminated
    }

    this.setAddressCache.clear();
    this.saplingIdCache.clear();
    this.tokenDecimalsCache.clear();
    this.tokenMetadataCache.clear();
    this.walletContractCache.clear();
    this.estimatorContractCache.clear();
    this.factoryStoragePromise = null;
    this.shieldedAddressPromise = undefined;
    this.viewingKeyPromise = undefined;

    // Zero out the secret key material so it cannot be recovered from memory
    this.#saplingKeyInfo = { skType: 'secretKey', sk: '' };
  };

  /**
   * @description Initialize the sapling set for the specified token contract and token id
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The confirmation of the initialized sapling set
   */
  initTokenSaplingSet = async (contract: string, tokenId?: number) => {
    const dappContract = await this.getContract(
      this.shieldBridgeContractAddress,
    );

    return dappContract.methodsObject
      .init_token_sapling_set({
        contract,
        token_id: tokenId,
      })
      .send()
      .then(async (op: WalletOperation) => {
        const confirmation = await this.awaitConfirmation(op);
        return { ...confirmation, opHash: op.opHash };
      });
  };
}
