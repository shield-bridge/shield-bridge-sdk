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
import { defaults, tokensGetTokens } from '@tzkt/sdk-api';
import BigNumber from 'bignumber.js';
import type { SaplingWorker } from './worker';

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
  | { saplingSecret: string; saplingMnemonic?: never }
  | { saplingSecret?: never; saplingMnemonic: string }
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
 * @class
 * @param {ShieldBridgeSDKConfig} config The configuration object for the Shield Bridge SDK
 * @param {TezosToolkit} config.client The TezosToolkit instance
 * @param {'mainnet' | 'ghostnet'} [config.tzktApi='mainnet'] The tzkt API to use
 * @param {number} [config.minConfirmations=1] The minimum number of confirmations for the transaction
 * @param {string} [config.saplingStateMapContract='KT1RYEs6rfXgHqeb2XzfHKRii5NsNyKbS6WM'] The sapling state map contract address
 * @param {number} [config.gasLimitBuffer=2_000] The buffer to add to the estimated gas limit
 * @param {number} [config.storageLimitBuffer=500] The buffer to add to the estimated storage limit
 * @param {boolean} [config.useBaseUnits=false] Whether to use base unit for the token amounts (mutez or token units with decimals)
 * @param {number} [config.parallelThreads=false] Whether to spawn parallel threads for the sapling worker
 * @param {string} [config.saplingSecret] The sapling secret key
 * @param {string} [config.saplingMnemonic] The sapling mnemonic
 * @returns {ShieldBridgeSDK} The Shield Bridge SDK instance
 * @example
 * const tezos = new TezosToolkit('https://mainnet.api.tez.ie');
 * const signerProvider = await InMemorySigner.fromSecretKey('edsk...');
 * tezos.setSignerProvider(signerProvider);
 * const shieldBridge = new ShieldBridgeSDK({
 *  client: tezos,
 *  saplingSecret: 'sask...'
 * });
 * await shieldBridge.shield([
 *   {
 *     amount: 1,
 *     contract: 'KT1...',
 *     tokenId: 0,
 *     memo: 'abcdefgh'
 *   }
 * ]);
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

  constructor(private config: ShieldBridgeSDKConfig) {
    this.tezosClient = config.client;
    this.minConfirmations = config.minConfirmations ?? 1;
    this.saplingStateMapContract =
      config.saplingStateMapContract ?? saplingStateMapContract.mainnet;
    this.gasLimitBuffer = config.gasLimitBuffer ?? 2_000;
    this.storageLimitBuffer = config.storageLimitBuffer ?? 500;
    this.useBaseUnits = config.useBaseUnits ?? false;
    this.parallelThreads = config.parallelThreads ?? false;
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
   * @description Get the sapling id for the token contract and token id if provided
   * @param {string} [contract] The token contract address
   * @param {number} [tokenId] The token id
   * @returns The sapling id for the token contract and token id if provided
   */
  getSaplingId = async (contract?: string, tokenId?: number) => {
    const contractStorage: ContractStorage = await fetch(
      `${defaults.baseUrl}/v1/contracts/${this.saplingStateMapContract}/storage`,
    ).then((res) => res.json());

    if (contract) {
      if (tokenId !== undefined) {
        return contractStorage.token_fa_2.find(
          (token) =>
            token.key.address === contract && token.key.nat === `${tokenId}`,
        )?.value;
      }
      return contractStorage.token_fa_1_2[contract];
    }
    return contractStorage.tez;
  };

  /**
   * @description Get the metadata for the token contract and token id if provided
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The metadata for the token contract and token id if provided
   */
  // eslint-disable-next-line class-methods-use-this
  getTokenMetadata = async (contract: string, tokenId?: number) => {
    const [metadata] = await tokensGetTokens({
      contract: {
        eq: contract,
      },
      select: {
        fields: ['metadata'],
      },
      ...(tokenId ? { tokenId: { eq: `${tokenId}` } } : {}),
    });
    return metadata;
  };

  /**
   * @description Get the number of decimals for the token contract and token id if provided
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The number of decimals for the token contract and token id if provided
   */
  getTokenDecimals = async (contract: string, tokenId?: number) => {
    const { decimals } = (await this.getTokenMetadata(contract, tokenId)) as {
      name?: string;
      symbol?: string;
      decimals: string;
    };
    return parseInt(decimals, 10);
  };

  /**
   * @description Estimate the gas and storage limits for the transaction list of shielding transactions
   * @param {OrderedTransactionList} transactionList The constructed transaction list
   * @returns The estimated gas and storage limits for the transaction list
   */
  estimateShieldTransactionLimits = async (
    transactionList: OrderedTransactionList,
  ) => {
    const contractEstimator = await this.tezosClient.contract.at(
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
  ) => {
    const dappContract = await this.tezosClient.wallet.at(
      this.saplingStateMapContract,
    );

    const transactionList: OrderedTransactionList = [[], [], [], []];

    // eslint-disable-next-line no-restricted-syntax
    for (const saplingDeposit of saplingDeposits) {
      const { owner, amount, saplingTransactions, contract, tokenId } =
        saplingDeposit;

      if (contract) {
        // eslint-disable-next-line no-await-in-loop
        const tokenContract = await this.tezosClient.wallet.at(contract);
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

    return batch.send().then((op) => op.confirmation(this.minConfirmations));
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
  ) => {
    const dappContract = await this.tezosClient.wallet.at(
      this.saplingStateMapContract,
    );

    const dappContractEstimator = await this.tezosClient.contract.at(
      this.saplingStateMapContract,
    );

    const saplingWithdrawalMethodObject = saplingWithdrawals.map(
      (saplingWithdrawal) => ({
        txns: saplingWithdrawal.saplingTransactions,
        contract: saplingWithdrawal.contract,
        token_id: saplingWithdrawal.tokenId,
      }),
    );

    const operation = dappContractEstimator.methodsObject.default(
      saplingWithdrawalMethodObject,
    );

    const estimate = await this.tezosClient.estimate.contractCall(operation);

    return dappContract.methodsObject
      .default(saplingWithdrawalMethodObject)
      .send({
        gasLimit: estimate.gasLimit + this.gasLimitBuffer,
        storageLimit: estimate.storageLimit + this.storageLimitBuffer,
        fee: this.getEstimatedFee(estimate),
      })
      .then((op) => op.confirmation(this.minConfirmations));
  };

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
  ) => {
    const dappContract = await this.tezosClient.wallet.at(
      this.saplingStateMapContract,
    );

    const dappContractEstimator = await this.tezosClient.contract.at(
      this.saplingStateMapContract,
    );

    const saplingTransferMethodObject = saplingTransfers.map(
      (saplingTransfer) => ({
        txns: saplingTransfer.saplingTransactions,
        contract: saplingTransfer.contract,
        token_id: saplingTransfer.tokenId,
      }),
    );

    const operation = dappContractEstimator.methodsObject.default(
      saplingTransferMethodObject,
    );

    const estimate = await this.tezosClient.estimate.contractCall(operation);

    return dappContract.methodsObject
      .default(saplingTransferMethodObject)
      .send({
        gasLimit: estimate.gasLimit + this.gasLimitBuffer,
        storageLimit: estimate.storageLimit + this.storageLimitBuffer,
        fee: this.getEstimatedFee(estimate),
      })
      .then((op) => op.confirmation(this.minConfirmations));
  };

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

    await this.ready;
    // eslint-disable-next-line prefer-destructuring
    let saplingWorker = this.saplingWorker;
    if (this.parallelThreads) {
      saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
    }

    const saplingId = await this.getSaplingId(contract, tokenId);
    if (!saplingId) {
      throw new Error('Sapling state not initialized for the token');
    }

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';

    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret!
          : this.config.saplingMnemonic!,
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
   * @returns The confirmation of the submitted sapling shielding transactions
   */
  shield = async (shieldParams: ShieldParams[]) => {
    let contractParams: {
      saplingTransactions: (string | void)[];
      owner: string;
      amount: number | string;
      contract?: string;
      tokenId?: number;
    }[] = [];

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

    return this.submitSaplingShieldTransaction(contractParams);
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

    await this.ready;
    // eslint-disable-next-line prefer-destructuring
    let saplingWorker = this.saplingWorker;
    if (this.parallelThreads) {
      saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
    }

    const saplingId = await this.getSaplingId(contract, tokenId);
    if (!saplingId) {
      throw new Error('Sapling state not initialized for the token');
    }

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';
    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret!
          : this.config.saplingMnemonic!,
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
   * @returns The confirmation of the submitted sapling unshielding transactions
   */
  unshield = async (unshieldParams: UnshieldParams[]) => {
    let contractParams: {
      saplingTransactions: (string | void)[];
      contract?: string;
      tokenId?: number;
    }[] = [];

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

    return this.submitSaplingUnshieldTransaction(contractParams);
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

    await this.ready;
    // eslint-disable-next-line prefer-destructuring
    let saplingWorker = this.saplingWorker;
    if (this.parallelThreads) {
      saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
    }

    const saplingId = await this.getSaplingId(contract, tokenId);
    if (!saplingId) {
      throw new Error('Sapling state not initialized for the token');
    }

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';
    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret!
          : this.config.saplingMnemonic!,
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
   * @returns The confirmation of the submitted sapling transfer transactions
   */
  transfer = async (transferParams: TransferParams[]) => {
    let contractParams: {
      saplingTransactions: (string | void)[];
      contract?: string;
      tokenId?: number;
    }[] = [];

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

    return this.submitSaplingTransferTransaction(contractParams);
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
    let saplingIdQuery = saplingId;
    if (!saplingIdQuery) {
      saplingIdQuery = await this.getSaplingId(contract, tokenId);
    }

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';

    await this.ready;
    // eslint-disable-next-line prefer-destructuring
    let saplingWorker = this.saplingWorker;
    if (this.parallelThreads) {
      saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
    }

    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret!
          : this.config.saplingMnemonic!,
      skType,
      saplingDetails: {
        contractAddress: this.saplingStateMapContract,
        memoSize: 8,
        saplingId: `${saplingIdQuery}`,
      },
      rpcUrl: this.tezosClient.rpc.getRpcUrl(),
    });

    const balance = (await saplingWorker.getSaplingBalance()) as number;

    let tokenDecimals = 6;
    if (contract) {
      tokenDecimals = await this.getTokenDecimals(contract, tokenId);
    }

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
      `${tzktApiMap.ghostnet}/v1/contracts/${this.saplingStateMapContract}/storage`,
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

    contractStorage.token_fa_2.forEach(({ key, value }) => {
      saplingIds.push({
        saplingId: value,
        contract: key.address,
        tokenId: parseInt(key.nat, 10),
      });
    });

    Object.entries(contractStorage.token_fa_1_2).forEach(
      ([contract, saplingId]) => {
        saplingIds.push({ saplingId, contract });
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
    const saplingId = await this.getSaplingId(contract, tokenId);
    if (!saplingId) {
      throw new Error('Sapling state not initialized for the token');
    }

    let tokenDecimals = 6;
    if (contract) {
      tokenDecimals = await this.getTokenDecimals(contract, tokenId);
    }

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';

    await this.ready;
    // eslint-disable-next-line prefer-destructuring
    let saplingWorker = this.saplingWorker;
    if (this.parallelThreads) {
      saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
    }

    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret!
          : this.config.saplingMnemonic!,
      skType,
      saplingDetails: {
        contractAddress: this.saplingStateMapContract,
        memoSize: 8,
        saplingId: `${saplingId}`,
      },
      rpcUrl: this.tezosClient.rpc.getRpcUrl(),
    });

    const transactions = await saplingWorker.getSaplingTransactions();

    if (this.parallelThreads) {
      await Thread.terminate(saplingWorker);
    }

    return {
      incoming: transactions!.incoming.map((transaction: any) => {
        if (this.useBaseUnits) {
          return transaction;
        }
        const value = new BigNumber(transaction.value)
          .dividedBy(new BigNumber(10).exponentiatedBy(tokenDecimals))
          .toNumber();
        return { ...transaction, value };
      }),
      outgoing: transactions!.outgoing.map((transaction: any) => {
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
    const saplingId = await this.getSaplingId();
    if (!saplingId) {
      throw new Error('Sapling state not initialized for the token');
    }

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';

    await this.ready;
    // eslint-disable-next-line prefer-destructuring
    let saplingWorker = this.saplingWorker;
    if (this.parallelThreads) {
      saplingWorker = await spawn<SaplingWorker>(new Worker(workerUrl), {
        timeout: 120_000,
      });
    }

    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret!
          : this.config.saplingMnemonic!,
      skType,
      saplingDetails: {
        contractAddress: this.saplingStateMapContract,
        memoSize: 8,
        saplingId: `${saplingId}`,
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
   * @description Initialize the sapling pool for the specified token contract and token id
   * @param {string} contract The token contract address
   * @param {number} [tokenId] The token id
   * @returns The confirmation of the initialized sapling pool
   */
  initTokenSaplingPool = async (contract: string, tokenId?: number) => {
    const dappContract = await this.tezosClient.wallet.at(
      this.saplingStateMapContract,
    );

    return dappContract.methodsObject
      .init_token_sapling_pool({
        contract,
        token_id: tokenId,
      })
      .send()
      .then((op) => op.confirmation(this.minConfirmations));
  };
}
