import { Buffer } from 'buffer';
import { ModuleThread, spawn, Thread, Worker } from 'threads';
import {
  ContractMethodObject,
  ContractProvider,
  Estimate,
  OpKind,
  TezosToolkit,
  TransferParams as TaquitoTransferParams,
  Wallet,
  withKind,
  WalletOperation,
} from '@tezos-x/octez.js';
import { BlockResponse } from '@tezos-x/octez.js-rpc';
import { defaults, TokenBalance } from '@tzkt/sdk-api';
import BigNumber from 'bignumber.js';
import type { SaplingWorker } from './worker';

// Make Buffer available globally for octez.js dependencies
if (typeof window !== 'undefined' && !window.Buffer) {
  window.Buffer = Buffer;
}

export const tzktApiMap = {
  mainnet: 'https://api.tzkt.io',
  ghostnet: 'https://api.ghostnet.tzkt.io',
};

/**
 * Contract architecture version for the SDK
 * - '2': Factory contract with individual set contracts (recommended)
 * - '1': Legacy map contract with inline sapling states (deprecated)
 */
export type ContractArchitecture = '1' | '2';

/**
 * Factory contract addresses for V2 architecture
 * Factory manages individual sapling set contracts for each asset
 */
export const saplingFactoryContract = {
  mainnet: 'KT1WqGXxe5Anam6Hm6zQqGmaXdtZrzZRynnw',
  ghostnet: 'KT1XaGzt1byBue5BLbXpmKFtg7AEgZSKYNrf',
};

/**
 * @deprecated Use saplingFactoryContract (V2) for new integrations
 * Map contract addresses for V1 architecture (legacy)
 * Map contract stores all sapling states inline
 */
export const saplingMapContract = {
  mainnet: 'KT1RYEs6rfXgHqeb2XzfHKRii5NsNyKbS6WM',
  ghostnet: 'KT1WorWEWjfQqQ1X2BFQiCc4hE3DuDKQVH4U',
};

/**
 * @deprecated Use saplingFactoryContract (V2) or saplingMapContract (V1)
 * Kept for backward compatibility - points to V1 map contract
 */
export const saplingStateMapContract = saplingMapContract;

/**
 * Internal transaction format for the V1 map contract (legacy)
 * Used by V1 shield path to batch sapling transactions through the map contract.
 *
 * @deprecated V1 is for migration only. V2 calls Set contracts directly.
 * @param txns - Sapling transactions (hex-encoded)
 * @param contract - Token contract address (undefined for Tez)
 * @param token_id - Token ID (for FA2 only)
 * @param amount - Amount in mutez (for Tez shielding only)
 */
type FactoryTransactionItem = {
  txns: (string | void)[];
  contract?: string;
  token_id?: number;
  amount?: number | string;
};

type OrderedTransactionList = [
  // FA2 update_operators add_operator
  ContractMethodObject<Wallet>[],
  // FA1.2 approve
  ContractMethodObject<Wallet>[],
  // Default transactions
  FactoryTransactionItem[],
  // FA2 update_operators remove_operator
  ContractMethodObject<Wallet>[],
];

interface SaplingDeposits {
  amount: number | string;
  saplingTransactions: (string | void)[];
  owner?: string;
  contract?: string;
  tokenId?: number;
}

interface SaplingTransactions {
  saplingTransactions: (string | void)[];
  contract?: string;
  tokenId?: number;
}

interface ShieldParams {
  amount: number;
  shieldedAddress?: string;
  contract?: string;
  tokenId?: number;
  memo?: string;
}

interface UnshieldParams {
  amount: number;
  unshieldedAddress?: string;
  contract?: string;
  tokenId?: number;
}

interface TransferParams {
  contract?: string;
  tokenId?: number;
  transfers: {
    amount: number;
    to: string;
    memo?: string;
  }[];
}

interface SaplingTokenInfo {
  setAddress?: string;
  contract?: string;
  tokenId?: number;
}

/**
 * Progress callbacks for transaction operations
 * Provides real-time updates during shield, unshield, and transfer operations
 *
 * @example
 * // Basic usage with progress tracking
 * await shieldBridge.shield([{ amount: 1, contract: 'KT1...' }], {
 *   onGenerating: (data) => console.log(`Generating sapling transaction`),
 *   onSigning: () => console.log('Signing transaction...'),
 *   onSubmitting: () => console.log('Submitting to network...'),
 *   onConfirmed: (data) => console.log(`Confirmed! Op: ${data.opHash}`)
 * });
 *
 * @example
 * // With a progress bar UI
 * let progress = 0;
 * await shieldBridge.transfer([...], {
 *   onGenerating: () => setProgress(50),
 *   onSigning: () => setProgress(65),
 *   onSubmitting: () => setProgress(80),
 *   onConfirmed: () => setProgress(100),
 * });
 *
 * @example
 * // With detailed step tracking
 * await shieldBridge.unshield([...], {
 *   onGenerating: ({ step, total, contract }) =>
 *     console.log(`Generating proof ${step}/${total} for ${contract}`),
 *   onConfirmed: ({ opHash }) =>
 *     window.open(`https://tzkt.io/${opHash}`, '_blank')
 * });
 */
interface TransactionProgressCallbacks {
  /** Called when preparing transaction parameters and generating sapling proofs */
  onGenerating?: (
    params: ShieldParams[] | TransferParams[] | UnshieldParams[],
  ) => void;
  /** Called when signing the transaction */
  onSigning?: () => void;
  /** Called when submitting to the network */
  onSubmitting?: (data: { opHash: string }) => void;
  /** Called when transaction is confirmed */
  onConfirmed?: (data: { opHash: string; block?: any }) => void;
}

enum OperationIndex {
  UPDATE_OPERATORS_ADD_INDEX = 0,
  APPROVE_INDEX = 1,
  DEFAULT_INDEX = 2,
  UPDATE_OPERATORS_REMOVE_INDEX = 3,
}

type ShieldBridgeSDKConfig = {
  client: TezosToolkit;
  tzktApi?: 'mainnet' | 'ghostnet';
  minConfirmations?: number;
  /**
   * Contract architecture version
   * - '2' (default): Factory contract with individual set contracts
   * - '1': Legacy map contract with inline sapling states
   * @deprecated V1 is for migration only. Use V2 for new integrations.
   */
  contractArchitecture?: ContractArchitecture;
  /** Factory contract address for V2 architecture */
  saplingFactoryContract?: string;
  /**
   * @deprecated Use saplingFactoryContract (V2) instead
   * Map contract address for V1 architecture
   */
  saplingMapContract?: string;
  /** @deprecated Use saplingFactoryContract or saplingMapContract */
  saplingStateMapContract?: string;
  gasLimitBuffer?: number;
  storageLimitBuffer?: number;
  useBaseUnits?: boolean;
  parallelThreads?: boolean;
} & (
  | {
      saplingSecret: string;
      saplingMnemonic?: never;
      saplingViewingKey?: never;
    }
  | {
      saplingSecret?: never;
      saplingMnemonic: string;
      saplingViewingKey?: never;
    }
  | {
      saplingSecret?: never;
      saplingMnemonic?: never;
      saplingViewingKey: string;
    }
);

const MINIMAL_FEE_MUTEZ = 100;
const MINIMAL_FEE_PER_BYTE_MUTEZ = 1;
const MINIMAL_FEE_PER_GAS_MUTEZ = 0.1;

const isBrowser: boolean =
  typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Default to loading the unbundled worker
let workerUrl = './worker';

if (isBrowser) {
  // Load the worker bundle in the browser environment
  workerUrl = new URL('./saplingWorker.js', import.meta.url).href;
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
 * @param {'mainnet' | 'ghostnet'} [config.tzktApi='mainnet'] The tzkt API to use
 * @param {number} [config.minConfirmations=1] The minimum number of confirmations for the transaction
 * @param {string} [config.saplingStateMapContract='KT1RYEs6rfXgHqeb2XzfHKRii5NsNyKbS6WM'] The sapling state map contract address
 * @param {number} [config.gasLimitBuffer=2_000] The buffer to add to the estimated gas limit
 * @param {number} [config.storageLimitBuffer=500] The buffer to add to the estimated storage limit
 * @param {boolean} [config.useBaseUnits=false] Whether to use base unit for the token amounts (mutez or token units with decimals)
 * @param {boolean} [config.parallelThreads=false] Whether to spawn parallel threads for the sapling worker
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
 * const balance = await viewOnlySdk.getShieldedBalance();
 * console.log('View-only mode:', viewOnlySdk.isViewOnlyMode); // true
 */
export class ShieldBridgeSDK {
  private tezosClient: TezosToolkit;

  private saplingWorker!: ModuleThread<SaplingWorker>;

  /**
   * The contract address used for operations
   * - V2: Factory contract address
   * - V1: Map contract address
   */
  saplingStateMapContract: string;

  /**
   * Contract architecture version
   * - '2': Factory contract with individual set contracts
   * - '1': Legacy map contract with inline sapling states
   * Can be changed at runtime via switchArchitecture()
   */
  contractArchitecture: ContractArchitecture;

  minConfirmations: number;

  gasLimitBuffer: number;

  storageLimitBuffer: number;

  useBaseUnits: boolean;

  parallelThreads: boolean;

  ready: Promise<boolean>;

  /**
   * Indicates whether the SDK is in view-only mode (using a viewing key)
   * When true, only read operations (balance, transactions, address) are available
   * Transaction operations (shield, unshield, transfer) will throw errors
   */
  readonly isViewOnlyMode: boolean;

  // Cache for set contract addresses (V2) or sapling IDs (V1)
  private setAddressCache: Map<string, Promise<string | undefined>> = new Map();

  // Cache for sapling IDs (V1 only)
  private saplingIdCache: Map<string, Promise<number | undefined>> = new Map();

  private tokenDecimalsCache: Map<string, Promise<number>> = new Map();

  private tokenMetadataCache: Map<string, Promise<any>> = new Map();

  // Cache for contract instances
  private walletContractCache: Map<string, any> = new Map();

  private estimatorContractCache: Map<string, any> = new Map();

  constructor(private config: ShieldBridgeSDKConfig) {
    this.tezosClient = config.client;
    this.minConfirmations = config.minConfirmations ?? 1;

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
    if (this.contractArchitecture === '1') {
      // V1: Use map contract
      this.saplingStateMapContract =
        config.saplingMapContract ??
        config.saplingStateMapContract ??
        saplingMapContract[config.tzktApi || 'mainnet'];
    } else {
      // V2: Use factory contract
      this.saplingStateMapContract =
        config.saplingFactoryContract ??
        config.saplingStateMapContract ??
        saplingFactoryContract[config.tzktApi || 'mainnet'];
    }

    this.gasLimitBuffer = config.gasLimitBuffer ?? 2_000;
    this.storageLimitBuffer = config.storageLimitBuffer ?? 500;
    this.useBaseUnits = config.useBaseUnits ?? false;
    this.parallelThreads = config.parallelThreads ?? false;
    this.isViewOnlyMode = !!config.saplingViewingKey;
    // This prevents multiple instances with a separate baseUrl since the SDK is a singleton
    defaults.baseUrl = tzktApiMap[this.config.tzktApi || 'mainnet'];
    this.ready = this.initializeSaplingWorker();
  }

  initializeSaplingWorker = async () => {
    try {
      this.saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
      return true;
    } catch (err: any) {
      console.log(err.message);
      throw new Error('Failed to initialize Sapling worker');
    }
  };

  /**
   * @description Get cached contract or fetch and cache it
   * @param contractAddress The contract address
   */
  private getContract = async (contractAddress: string) => {
    if (this.walletContractCache.has(contractAddress)) {
      return this.walletContractCache.get(contractAddress);
    }

    const contract = await this.tezosClient.wallet.at(contractAddress);
    this.walletContractCache.set(contractAddress, contract);
    return contract;
  };

  /**
   * @description Get cached estimator contract or fetch and cache it
   * @param contractAddress The contract address
   */
  private getEstimatorContract = async (contractAddress: string) => {
    if (this.estimatorContractCache.has(contractAddress)) {
      return this.estimatorContractCache.get(contractAddress);
    }

    const contract = await this.tezosClient.contract.at(contractAddress);
    this.estimatorContractCache.set(contractAddress, contract);
    return contract;
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
    saplingWorker: ModuleThread<SaplingWorker>;
    setAddress: string;
    tokenDecimals: number;
  }> => {
    try {
      await this.ready;
      // eslint-disable-next-line prefer-destructuring
      let saplingWorker = this.saplingWorker;
      if (this.parallelThreads) {
        saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
          timeout: 120_000,
        });
      }

      // Determine the key type and value based on what's provided in the config
      let skType: 'secretKey' | 'mnemonic' | 'viewingKey';
      let sk: string;

      if (this.config.saplingSecret) {
        skType = 'secretKey';
        sk = this.config.saplingSecret;
      } else if (this.config.saplingViewingKey) {
        skType = 'viewingKey';
        sk = this.config.saplingViewingKey;
      } else {
        skType = 'mnemonic';
        sk = this.config.saplingMnemonic!;
      }

      // Handle V1 vs V2 architecture differently
      let setAddress: string;

      if (this.contractArchitecture === '1') {
        // V1: Use saplingId and map contract
        const saplingId =
          providedSaplingId ?? (await this.getSaplingId(contract, tokenId));
        if (saplingId === undefined) {
          const tokenInfo = contract
            ? `contract ${contract}${tokenId !== undefined ? ` tokenId ${tokenId}` : ''}`
            : 'tez';
          throw new Error(`Sapling state not initialized for ${tokenInfo}`);
        }

        await saplingWorker.loadSaplingSecret({
          sk,
          skType,
          saplingDetails: {
            contractAddress: this.saplingStateMapContract,
            memoSize: 8,
            saplingId: `${saplingId}`,
          },
          rpcUrl: this.tezosClient.rpc.getRpcUrl(),
        });

        // For V1, setAddress is the map contract itself
        setAddress = this.saplingStateMapContract;
      } else {
        // V2: Use setAddress (individual set contract)
        const fetchedSetAddress =
          providedSetAddress ?? (await this.getSetAddress(contract, tokenId));
        if (!fetchedSetAddress) {
          const tokenInfo = contract
            ? `contract ${contract}${tokenId !== undefined ? ` tokenId ${tokenId}` : ''}`
            : 'tez';
          throw new Error(`Sapling set not initialized for ${tokenInfo}`);
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
      }

      // Default token decimals
      let tokenDecimals = 6;
      if (contract) {
        tokenDecimals = await this.getTokenDecimals(contract, tokenId);
      }

      return { saplingWorker, setAddress, tokenDecimals };
    } catch (error: any) {
      const tokenInfo = contract
        ? `contract ${contract}${tokenId !== undefined ? ` tokenId ${tokenId}` : ''}`
        : 'tez';
      throw new Error(
        `Failed to initialize sapling worker for ${tokenInfo}: ${error.message}`,
      );
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
        // Fetch factory storage using Taquito RPC
        const factoryContract = await this.tezosClient.contract.at(
          this.saplingStateMapContract,
        );
        const factoryStorage: any = await factoryContract.storage();

        let setAddress: string | undefined;

        if (contract) {
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
          // TEZ - direct storage field
          setAddress = factoryStorage.tez || undefined;
        }

        return setAddress;
      } catch (error: any) {
        // Remove from cache on error so it can be retried
        this.setAddressCache.delete(cacheKey);
        throw new Error(
          `Failed to get set address for ${cacheKey}: ${error.message}`,
        );
      }
    })();

    // Cache the promise immediately before any await
    this.setAddressCache.set(cacheKey, setAddressPromise);

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
          `${defaults.baseUrl}/v1/contracts/${this.saplingStateMapContract}/storage`,
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
      } catch (error: any) {
        // Remove from cache on error so it can be retried
        this.saplingIdCache.delete(cacheKey);
        throw new Error(
          `Failed to get sapling ID for ${cacheKey}: ${error.message}`,
        );
      }
    })();

    // Cache the promise immediately before any await
    this.saplingIdCache.set(cacheKey, saplingIdPromise);

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
          `${defaults.baseUrl}/v1/tokens?contract=${contract}${tokenIdParam}&limit=1`,
        );
        const tokens = await response.json();

        if (tokens && tokens.length > 0) {
          return tokens[0].metadata;
        }

        return {};
      } catch (error: any) {
        // Remove from cache on error so it can be retried
        this.tokenMetadataCache.delete(cacheKey);
        throw new Error(
          `Failed to get token metadata for ${cacheKey}: ${error.message}`,
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
        )) as {
          name?: string;
          symbol?: string;
          decimals: string;
        };
        return parseInt(decimals, 10);
      } catch (error: any) {
        // Remove from cache on error so it can be retried
        this.tokenDecimalsCache.delete(cacheKey);
        throw new Error(
          `Failed to get token decimals for ${cacheKey}: ${error.message}`,
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

    // Query balances from each set contract in parallel
    const balancePromises = setAssets.map(async (asset) => {
      const balances: TokenBalance[] = await fetch(
        `${defaults.baseUrl}/v1/tokens/balances?account=${asset.setAddress}&sort.desc=balanceValue&limit=100&offset=0`,
      ).then((res) => res.json());

      return balances.map((token) => {
        let unitAmount: number | string = token.balance as string;
        if (!this.useBaseUnits) {
          unitAmount = new BigNumber(unitAmount)
            .dividedBy(
              new BigNumber(10).exponentiatedBy(
                token.token?.metadata?.decimals ?? 6,
              ),
            )
            .toNumber();
        }
        return {
          ...token,
          balance: unitAmount,
          setAddress: asset.setAddress, // Include which set contract holds this
        };
      });
    });

    const allBalances = await Promise.all(balancePromises);
    return allBalances.flat();
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
      this.saplingStateMapContract,
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
              amount,
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
        // @ts-ignore string is an acceptible type for amount
        ...operation.toTransferParams(params),
      }));

    return this.tezosClient.estimate.batch(estimateBatch);
  };

  /**
   * @description Get the estimated fee for the transaction
   * @param {Estimate} estimate The estimate object
   * @returns The estimated fee for the transaction
   */
  getEstimatedFee = (estimate: Estimate) => {
    const operationFeeMutez =
      (estimate.gasLimit + this.gasLimitBuffer) * MINIMAL_FEE_PER_GAS_MUTEZ +
      Number(estimate.opSize) * MINIMAL_FEE_PER_BYTE_MUTEZ;

    return Math.ceil(Number(operationFeeMutez + MINIMAL_FEE_MUTEZ * 1.2));
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
    const dappContract = await this.getContract(this.saplingStateMapContract);

    const transactionList: OrderedTransactionList = [[], [], [], []];

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

        if (tokenId !== undefined) {
          // FA2 update_operators add_operator
          transactionList[OperationIndex.UPDATE_OPERATORS_ADD_INDEX].push(
            tokenContract.methodsObject.update_operators([
              {
                add_operator: {
                  owner,
                  operator: setAddress,
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
                  operator: setAddress,
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
              spender: setAddress,
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
              // @ts-ignore string is an acceptible type for amount
              amount,
              mutez: true,
              gasLimit: estimate!.gasLimit + this.gasLimitBuffer,
              storageLimit: estimate!.storageLimit + this.storageLimitBuffer,
              fee: this.getEstimatedFee(estimate!),
            },
          );
        }
        // If token deposits are present, batch them separately from tez deposits
        if (nonTezTransactions.length) {
          const estimate = estimates.shift();
          batch.withContractCall(
            dappContract.methodsObject.default(nonTezTransactions),
            {
              gasLimit: estimate!.gasLimit + this.gasLimitBuffer,
              storageLimit: estimate!.storageLimit + this.storageLimitBuffer,
              fee: this.getEstimatedFee(estimate!),
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
      const confirmation = await op.confirmation(this.minConfirmations);
      callbacks?.onConfirmed?.({ opHash: op.opHash, block: confirmation });
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
              value: amount,
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
          params: { amount, mutez: true },
        });
      }
    }

    // Estimate all operations
    const estimateBatch: withKind<TaquitoTransferParams, OpKind.TRANSACTION>[] =
      ops.map(({ method, params = {} }) => ({
        kind: OpKind.TRANSACTION,
        // @ts-ignore string is an acceptible type for amount
        ...method.toTransferParams(params),
      }));
    const estimates = await this.tezosClient.estimate.batch(estimateBatch);

    // Build and send batch
    const batch = this.tezosClient.wallet.batch();
    ops.forEach(({ method, params = {} }, i) => {
      const estimate = estimates[i];
      // @ts-ignore string is an acceptible type for amount
      batch.withContractCall(method, {
        ...params,
        gasLimit: estimate.gasLimit + this.gasLimitBuffer,
        storageLimit: estimate.storageLimit + this.storageLimitBuffer,
        fee: this.getEstimatedFee(estimate),
      });
    });

    callbacks?.onSigning?.();
    return batch.send().then(async (op) => {
      callbacks?.onSubmitting?.({ opHash: op.opHash });
      const confirmation = await op.confirmation(this.minConfirmations);
      callbacks?.onConfirmed?.({ opHash: op.opHash, block: confirmation });
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
    const dappContract = await this.getContract(this.saplingStateMapContract);

    const dappContractEstimator = await this.getEstimatorContract(
      this.saplingStateMapContract,
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
        gasLimit: estimate.gasLimit + this.gasLimitBuffer,
        storageLimit: estimate.storageLimit + this.storageLimitBuffer,
        fee: this.getEstimatedFee(estimate),
      })
      .then(async (op: WalletOperation) => {
        callbacks?.onSubmitting?.({ opHash: op.opHash });
        const confirmation = await op.confirmation(this.minConfirmations);
        callbacks?.onConfirmed?.({ opHash: op.opHash, block: confirmation });
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
        gasLimit: estimate.gasLimit + this.gasLimitBuffer,
        storageLimit: estimate.storageLimit + this.storageLimitBuffer,
        fee: this.getEstimatedFee(estimate),
      });
    });

    callbacks?.onSigning?.();
    return batch.send().then(async (op: WalletOperation) => {
      callbacks?.onSubmitting?.({ opHash: op.opHash });
      const confirmation = await op.confirmation(this.minConfirmations);
      callbacks?.onConfirmed?.({ opHash: op.opHash, block: confirmation });
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

    const { saplingWorker, tokenDecimals } =
      await this.initializeSaplingWorkerWithState(contract, tokenId);

    let unitAmount: number | string = amount;
    if (!this.useBaseUnits) {
      unitAmount = new BigNumber(10)
        .exponentiatedBy(tokenDecimals)
        .times(amount)
        .toString();
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
        // @ts-ignore string is an acceptible type for amount
        amount: unitAmount,
        memo,
        mutez: true,
      },
    ]);

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    const owner = await this.tezosClient.wallet.pkh();

    return {
      saplingTransactions: [saplingTxn],
      owner,
      amount: unitAmount,
      contract,
      tokenId,
    };
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

    let contractParams: {
      saplingTransactions: (string | void)[];
      owner: string;
      amount: number | string;
      contract?: string;
      tokenId?: number;
    }[] = [];

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

    return this.submitSaplingShieldTransaction(contractParams, callbacks);
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

    const { saplingWorker, tokenDecimals } =
      await this.initializeSaplingWorkerWithState(contract, tokenId);

    let unitAmount: number | string = amount;
    if (!this.useBaseUnits) {
      unitAmount = new BigNumber(10)
        .exponentiatedBy(tokenDecimals)
        .times(amount)
        .toString();
    }

    let to = unshieldedAddress;
    // If no unshielded address is provided, default to the wallet public key hash
    if (!to) {
      to = await this.tezosClient.wallet.pkh();
    }
    const saplingTxn = await saplingWorker.prepareUnshieldedTransaction({
      to,
      // @ts-ignore string is an acceptible type for amount
      amount: unitAmount,
      mutez: true,
    });

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    return {
      saplingTransactions: [saplingTxn],
      contract,
      tokenId,
    };
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

    let contractParams: {
      saplingTransactions: (string | void)[];
      contract?: string;
      tokenId?: number;
    }[] = [];

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

    return this.submitSaplingUnshieldTransaction(contractParams, callbacks);
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
    });

    const { saplingWorker, tokenDecimals } =
      await this.initializeSaplingWorkerWithState(contract, tokenId);

    const saplingTransfers = transfers.map(({ amount, to, memo }) => {
      let unitAmount: string | number = amount;

      if (!this.useBaseUnits) {
        unitAmount = new BigNumber(10)
          .exponentiatedBy(tokenDecimals)
          .times(amount)
          .toString();
      }

      return {
        to,
        amount: unitAmount,
        memo,
        mutez: true,
      };
    });

    const saplingTxn =
      // @ts-ignore string is an acceptible type for amount
      await saplingWorker.prepareSaplingTransaction(saplingTransfers);

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    return {
      saplingTransactions: [saplingTxn],
      contract,
      tokenId,
    };
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

    let contractParams: {
      saplingTransactions: (string | void)[];
      contract?: string;
      tokenId?: number;
    }[] = [];

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

    return this.submitSaplingTransferTransaction(contractParams, callbacks);
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
  }: SaplingTokenInfo): Promise<number> => {
    // Pass the known setAddress to avoid redundant API call
    const { saplingWorker, tokenDecimals } =
      await this.initializeSaplingWorkerWithState(
        contract,
        tokenId,
        setAddress,
      );

    const balance = (await saplingWorker.getSaplingBalance()) as number;

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    if (this.useBaseUnits) {
      return balance;
    }

    return new BigNumber(balance)
      .dividedBy(new BigNumber(10).exponentiatedBy(tokenDecimals))
      .toNumber();
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
  ): Promise<
    {
      setAddress: string;
      contract?: string;
      tokenId?: number;
      metadata?: any;
    }[]
  > => {
    // Get factory storage to retrieve big map IDs
    const factoryContract = await this.tezosClient.contract.at(
      this.saplingStateMapContract,
    );
    const factoryStorage: any = await factoryContract.storage();

    const setAddresses: {
      setAddress: string;
      contract?: string;
      tokenId?: number;
    }[] = [];

    // Add TEZ set if it exists
    const tezAddress = factoryStorage.tez || undefined;
    if (tezAddress) {
      setAddresses.push({
        setAddress: tezAddress,
      });
      // Cache tez set address
      this.setAddressCache.set('tez', Promise.resolve(tezAddress));
    }

    // Enumerate FA2 token sets from big map
    // factoryStorage.token_fa_2 is a big map ID
    const fa2BigMapId = factoryStorage.token_fa_2;

    const fa2Keys: Array<{
      key: { address: string; nat: string };
      value: string;
    }> = await fetch(
      `${defaults.baseUrl}/v1/bigmaps/${fa2BigMapId}/keys?active=true`,
    ).then((res) => res.json());

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

    // Enumerate FA1.2 token sets from big map
    // factoryStorage.token_fa_1_2 is a big map ID
    const fa12BigMapId = factoryStorage.token_fa_1_2;

    const fa12Keys: Array<{ key: string; value: string }> = await fetch(
      `${defaults.baseUrl}/v1/bigmaps/${fa12BigMapId}/keys?active=true`,
    ).then((res) => res.json());

    fa12Keys.forEach(({ key: contract, value: setAddress }) => {
      setAddresses.push({ setAddress, contract });

      // Cache FA1.2 token set address
      this.setAddressCache.set(contract, Promise.resolve(setAddress));
    });

    if (!includeMetadata) {
      return setAddresses;
    }

    const withMetadata = setAddresses.map((asset) => {
      if (asset.contract) {
        return this.getTokenMetadata(asset.contract, asset.tokenId).then(
          (tokenMetadata) => ({
            ...asset,
            metadata: tokenMetadata,
          }),
        );
      }
      return asset;
    });

    return Promise.all(withMetadata);
  };

  /**
   * @description Get the shielded sapling token balances for all the sapling tokens
   * @returns The shielded sapling token balances for all the sapling tokens
   */
  getAllShieldedBalances = async () => {
    const setAssets = await this.getAllShieldedAssets();

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
  getShieldedTransactions = async (contract?: string, tokenId?: number) => {
    const { saplingWorker, tokenDecimals } =
      await this.initializeSaplingWorkerWithState(contract, tokenId);

    const transactions = await saplingWorker.getSaplingTransactions();

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

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
  };

  /**
   * @description Get the sapling payment address of the currently loaded sapling key
   * @returns The sapling payment address
   */
  getShieldedAddress = async () => {
    // Generating a shielded address doesn't require fetching the set address
    // or loading blockchain state - we just need the sapling secret/mnemonic
    await this.ready;
    let { saplingWorker } = this;
    if (this.parallelThreads) {
      saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
    }

    // Determine the key type and value based on what's provided in the config
    let skType: 'secretKey' | 'mnemonic' | 'viewingKey';
    let sk: string;

    if (this.config.saplingSecret) {
      skType = 'secretKey';
      sk = this.config.saplingSecret;
    } else if (this.config.saplingViewingKey) {
      skType = 'viewingKey';
      sk = this.config.saplingViewingKey;
    } else {
      skType = 'mnemonic';
      sk = this.config.saplingMnemonic!;
    }

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

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    return saplingPaymentAddress.address;
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
    // Update architecture setting
    this.contractArchitecture = architecture;

    // Update contract address
    if (contractAddress) {
      this.saplingStateMapContract = contractAddress;
    } else if (architecture === '1') {
      this.saplingStateMapContract =
        saplingMapContract[this.config.tzktApi || 'mainnet'];
    } else {
      this.saplingStateMapContract =
        saplingFactoryContract[this.config.tzktApi || 'mainnet'];
    }

    // Clear architecture-specific caches
    this.walletContractCache.clear();
    this.estimatorContractCache.clear();

    console.log(
      `[ShieldBridgeSDK] Switched to ${architecture === '1' ? 'V1 (Map)' : 'V2 (Factory)'}: ${this.saplingStateMapContract}`,
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
   * const balance = await viewOnlySdk.getShieldedBalance();
   */
  getViewingKey = async () => {
    const { saplingWorker } = await this.initializeSaplingWorkerWithState();

    const viewingKey = await saplingWorker.getViewingKey();

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    return viewingKey;
  };

  /**
   * @description Initialize the sapling set for the specified token contract and token id
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The confirmation of the initialized sapling set
   */
  initTokenSaplingSet = async (contract: string, tokenId?: number) => {
    const dappContract = await this.getContract(this.saplingStateMapContract);

    return dappContract.methodsObject
      .init_token_sapling_set({
        contract,
        token_id: tokenId,
      })
      .send()
      .then(async (op: WalletOperation) => {
        const confirmation = await op.confirmation(this.minConfirmations);
        return { ...confirmation, opHash: op.opHash };
      });
  };
}
