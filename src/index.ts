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
} from '@taquito/taquito';
import {
  defaults,
  tokensGetTokens,
  TokenBalance,
  Contract,
} from '@tzkt/sdk-api';
import BigNumber from 'bignumber.js';
import type { SaplingWorker } from './worker';

// Make Buffer available globally for @taquito dependencies
if (typeof window !== 'undefined' && !window.Buffer) {
  window.Buffer = Buffer;
}

export const tzktApiMap = {
  mainnet: 'https://api.tzkt.io',
  ghostnet: 'https://api.ghostnet.tzkt.io',
};

export const saplingStateMapContract = {
  mainnet: 'KT1RYEs6rfXgHqeb2XzfHKRii5NsNyKbS6WM',
  ghostnet: 'KT1WorWEWjfQqQ1X2BFQiCc4hE3DuDKQVH4U',
};

type OrderedTransactionList = [
  // FA2 update_operators add_operator
  ContractMethodObject<Wallet>[],
  // FA1.2 approve
  ContractMethodObject<Wallet>[],
  // Default transactions
  {
    txns: (string | void)[];
    contract?: string;
    token_id?: number;
    amount?: number | string;
  }[],
  // FA2 update_operators remove_operator
  ContractMethodObject<Wallet>[],
];

interface ContractStorage {
  tez: number;
  token_fa_2: {
    key: {
      nat: string;
      address: string;
    };
    value: number;
  }[];
  token_fa_1_2: {
    [contract: string]: number;
  };
}

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
  saplingId?: number;
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
  workerUrl = new URL('./workerBundle.js', import.meta.url).href;
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

  saplingStateMapContract: string;

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

  // Cache for saplingIds, token decimals, and token metadata
  private saplingIdCache: Map<string, Promise<number | undefined>> = new Map();

  private tokenDecimalsCache: Map<string, Promise<number>> = new Map();

  private tokenMetadataCache: Map<string, Promise<any>> = new Map();

  // Cache for contract instances
  private walletContractCache: Map<string, any> = new Map();

  private estimatorContractCache: Map<string, any> = new Map();

  constructor(private config: ShieldBridgeSDKConfig) {
    this.tezosClient = config.client;
    this.minConfirmations = config.minConfirmations ?? 1;
    this.saplingStateMapContract =
      config.saplingStateMapContract ?? saplingStateMapContract.mainnet;
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
    // Wait for the worker to be ready
    await new Promise((resolve) => {
      setTimeout(resolve, 2000);
    });

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
   * @description Validate amount is positive and not NaN
   * @param amount The amount to validate
   * @param context Context for error message
   */
  private static validateAmount(amount: number, context: string = 'Amount') {
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
      throw new Error(`${context} must be a valid number`);
    }
    if (amount <= 0) {
      throw new Error(`${context} must be greater than 0`);
    }
  }

  /**
   * @description Validate Tezos address format (basic validation)
   * @param address The address to validate
   * @param context Context for error message
   */
  private static validateAddress(address: string, context: string = 'Address') {
    if (!address || typeof address !== 'string') {
      throw new Error(`${context} must be a valid string`);
    }
    // Basic Tezos address validation (tz1, tz2, tz3, tz4, KT1)
    const addressPattern = /^(tz1|tz2|tz3|tz4|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/;
    if (!addressPattern.test(address)) {
      throw new Error(`${context} has invalid format: ${address}`);
    }
  }

  /**
   * @description Get cached wallet contract or fetch and cache it
   * @param contractAddress The contract address
   */
  private getWalletContract = async (contractAddress: string) => {
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
   * @param providedSaplingId The sapling id if already known (optional, to avoid redundant API call)
   * @returns The initialized sapling worker and sapling id
   */
  private initializeSaplingWorkerWithState = async (
    contract?: string,
    tokenId?: number,
    providedSaplingId?: number,
  ): Promise<{
    saplingWorker: ModuleThread<SaplingWorker>;
    saplingId: number;
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

      // Use provided saplingId if available, otherwise fetch it
      const saplingId =
        providedSaplingId ?? (await this.getSaplingId(contract, tokenId));
      if (!saplingId) {
        const tokenInfo = contract
          ? `contract ${contract}${tokenId !== undefined ? ` tokenId ${tokenId}` : ''}`
          : 'tez';
        throw new Error(`Sapling state not initialized for ${tokenInfo}`);
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

      // Default token decimals
      let tokenDecimals = 6;
      if (contract) {
        tokenDecimals = await this.getTokenDecimals(contract, tokenId);
      }

      return { saplingWorker, saplingId, tokenDecimals };
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
   * @description Get the sapling id for the token contract and token id if provided
   * @param {string} [contract] The token contract address
   * @param {number} [tokenId] The token id
   * @returns The sapling id for the token contract and token id if provided
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
        const contractStorage: ContractStorage = await fetch(
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
            saplingId = contractStorage.token_fa_2.find(
              (token) =>
                token.key.address === contract &&
                token.key.nat === `${tokenId}`,
            )?.value;
          } else {
            saplingId = contractStorage.token_fa_1_2[contract];
          }
        } else {
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
        const [metadata] = await tokensGetTokens({
          contract: {
            eq: contract,
          },
          select: {
            fields: ['metadata'],
          },
          ...(tokenId !== undefined ? { tokenId: { eq: `${tokenId}` } } : {}),
          limit: 1,
        });

        return metadata;
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
   * @description Get the total shielded pool balances for the sapling state map contract
   * @returns The total shielded pool balances
   */
  getTotalShieldedPoolBalances = async () => {
    const poolBalances: TokenBalance[] = await fetch(
      `${defaults.baseUrl}/v1/tokens/balances?account=${this.saplingStateMapContract}&sort.desc=balanceValue&limit=100&offset=0`,
    ).then((res) => res.json());

    return poolBalances.map((token) => {
      let unitAmount: number | string = token.balance as string;
      if (!this.useBaseUnits) {
        unitAmount = new BigNumber(unitAmount)
          .dividedBy(
            new BigNumber(10).exponentiatedBy(
              token.token?.metadata?.decimals || 6,
            ),
          )
          .toNumber();
      }
      return {
        ...token,
        balance: unitAmount,
      };
    });
  };

  /**
   * @description Get the sapling state map contract data
   * @returns The sapling state map contract data
   */
  getContractData = async () => {
    const contract: Contract = await fetch(
      `${defaults.baseUrl}/v1/accounts/${this.saplingStateMapContract}`,
    ).then((res) => res.json());

    if (!this.useBaseUnits) {
      let unitAmount: number | string = contract.balance as number;
      unitAmount = new BigNumber(unitAmount)
        .dividedBy(new BigNumber(10).exponentiatedBy(6))
        .toNumber();

      return {
        ...contract,
        balance: unitAmount,
      };
    }

    return contract;
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
        const nonTezTransactions: {
          txns: (string | void)[];
          contract?: string;
          token_id?: number;
        }[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for (const transaction of transactionList[index]) {
          const { amount, ...rest } = transaction;
          // amount is only present for tez deposits
          if (!amount) {
            nonTezTransactions.push(rest);
            // eslint-disable-next-line no-continue
            continue;
          }

          batch.push([
            contractEstimator.methodsObject.default([rest]),
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
    const dappContract = await this.getWalletContract(
      this.saplingStateMapContract,
    );

    const transactionList: OrderedTransactionList = [[], [], [], []];

    // eslint-disable-next-line no-restricted-syntax
    for (const saplingDeposit of saplingDeposits) {
      const { owner, amount, saplingTransactions, contract, tokenId } =
        saplingDeposit;

      if (contract) {
        // eslint-disable-next-line no-await-in-loop
        const tokenContract = await this.getWalletContract(contract);
        if (tokenId !== undefined) {
          // FA2 update_operators add_operator
          transactionList[OperationIndex.UPDATE_OPERATORS_ADD_INDEX].push(
            tokenContract.methodsObject.update_operators([
              {
                add_operator: {
                  owner,
                  operator: this.saplingStateMapContract,
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
                  operator: this.saplingStateMapContract,
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
              spender: this.saplingStateMapContract,
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
        const nonTezTransactions: {
          txns: (string | void)[];
          contract?: string;
          token_id?: number;
        }[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for (const transaction of transactionList[index]) {
          const { amount, ...rest } = transaction;
          // amount is only present for tez deposits
          if (!amount) {
            nonTezTransactions.push(rest);
            // eslint-disable-next-line no-continue
            continue;
          }

          const estimate = estimates.shift();
          batch.withContractCall(dappContract.methodsObject.default([rest]), {
            // @ts-ignore string is an acceptible type for amount
            amount,
            mutez: true,
            gasLimit: estimate!.gasLimit + this.gasLimitBuffer,
            storageLimit: estimate!.storageLimit + this.storageLimitBuffer,
            fee: this.getEstimatedFee(estimate!),
          });
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
  ) => {
    const dappContract = await this.getWalletContract(
      this.saplingStateMapContract,
    );

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
      .then(async (op: any) => {
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

    // Validate inputs
    ShieldBridgeSDK.validateAmount(amount, 'Shield amount');
    if (contract) {
      ShieldBridgeSDK.validateAddress(contract, 'Contract address');
    }
    if (shieldedAddress) {
      // Shielded addresses have different format - basic validation
      if (!shieldedAddress || typeof shieldedAddress !== 'string') {
        throw new Error('Shielded address must be a valid string');
      }
    }

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

    // Validate inputs
    ShieldBridgeSDK.validateAmount(amount, 'Unshield amount');
    if (contract) {
      ShieldBridgeSDK.validateAddress(contract, 'Contract address');
    }
    if (unshieldedAddress) {
      ShieldBridgeSDK.validateAddress(unshieldedAddress, 'Unshielded address');
    }

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
    if (contract) {
      ShieldBridgeSDK.validateAddress(contract, 'Contract address');
    }
    transfers.forEach((transfer, index) => {
      ShieldBridgeSDK.validateAmount(
        transfer.amount,
        `Transfer[${index}] amount`,
      );
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
   * @param {number} [saplingTokenInfo.saplingId] The sapling id
   * @param {string} [saplingTokenInfo.contract] The token contract address
   * @param {number} [saplingTokenInfo.tokenId] The token id
   * @returns The shielded sapling token balance for the currently loaded shielded address
   */
  getShieldedBalance = async ({
    saplingId,
    contract,
    tokenId,
  }: SaplingTokenInfo): Promise<number> => {
    // Pass the known saplingId to avoid redundant API call
    const { saplingWorker, tokenDecimals } =
      await this.initializeSaplingWorkerWithState(contract, tokenId, saplingId);

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
   * @returns The shielded sapling tokens
   */
  getAllShieldedAssets = async (
    includeMetadata: boolean = false,
  ): Promise<
    {
      saplingId: number;
      contract?: string;
      tokenId?: number;
      metadata?: any;
    }[]
  > => {
    const contractStorage: ContractStorage = await fetch(
      `${defaults.baseUrl}/v1/contracts/${this.saplingStateMapContract}/storage`,
    ).then((res) => res.json());

    const saplingIds: {
      saplingId: number;
      contract?: string;
      tokenId?: number;
    }[] = [
      {
        saplingId: contractStorage.tez,
      },
    ];

    // Cache tez sapling ID
    this.saplingIdCache.set('tez', Promise.resolve(contractStorage.tez));

    contractStorage.token_fa_2.forEach(({ key, value }) => {
      const tokenId = parseInt(key.nat, 10);
      saplingIds.push({
        saplingId: value,
        contract: key.address,
        tokenId,
      });

      // Cache FA2 token sapling ID
      const cacheKey = `${key.address}:${tokenId}`;
      this.saplingIdCache.set(cacheKey, Promise.resolve(value));
    });

    Object.entries(contractStorage.token_fa_1_2).forEach(
      ([contract, saplingId]) => {
        saplingIds.push({ saplingId, contract });

        // Cache FA1.2 token sapling ID
        this.saplingIdCache.set(contract, Promise.resolve(saplingId));
      },
    );

    if (!includeMetadata) {
      return saplingIds;
    }

    const withMetadata = saplingIds.map((saplingId) => {
      if (saplingId.contract) {
        return this.getTokenMetadata(
          saplingId.contract,
          saplingId.tokenId,
        ).then((tokenMetadata) => ({
          ...saplingId,
          metadata: tokenMetadata,
        }));
      }
      return saplingId;
    });

    return Promise.all(withMetadata);
  };

  /**
   * @description Get the shielded sapling token balances for all the sapling tokens
   * @returns The shielded sapling token balances for all the sapling tokens
   */
  getAllShieldedBalances = async () => {
    const saplingIds = await this.getAllShieldedAssets();

    const balances: {
      saplingId: number;
      contract?: string;
      tokenId?: number;
      balance: number;
    }[] = [];

    for (let i = 0; i < saplingIds.length; i += 1) {
      const saplingToken = saplingIds[i];
      // eslint-disable-next-line no-await-in-loop
      const balance = await this.getShieldedBalance(saplingToken);
      balances.push({ ...saplingToken, balance });
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
    const { saplingWorker } = await this.initializeSaplingWorkerWithState();

    const saplingPaymentAddress = await saplingWorker.getPaymentAddress();

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    return saplingPaymentAddress.address;
  };

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
   * @description Initialize the sapling pool for the specified token contract and token id
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The confirmation of the initialized sapling pool
   */
  initTokenSaplingPool = async (contract: string, tokenId?: number) => {
    // Validate inputs
    ShieldBridgeSDK.validateAddress(contract, 'Contract address');

    const dappContract = await this.getWalletContract(
      this.saplingStateMapContract,
    );

    return dappContract.methodsObject
      .init_token_sapling_pool({
        contract,
        token_id: tokenId,
      })
      .send()
      .then(async (op: any) => {
        const confirmation = await op.confirmation(this.minConfirmations);
        return { ...confirmation, opHash: op.opHash };
      });
  };
}
