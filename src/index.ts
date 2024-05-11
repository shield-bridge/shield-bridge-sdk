import { spawn, Thread, Worker } from 'threads';
import {
  ContractMethodObject,
  ContractProvider,
  Estimate,
  OpKind,
  TezosToolkit,
  TransferParams,
  Wallet,
  withKind,
} from '@taquito/taquito';
import { defaults, tokensGetTokens } from '@tzkt/sdk-api';
import BigNumber from 'bignumber.js';

export const tzktApiMap = {
  mainnet: 'https://api.tzkt.io',
  ghostnet: 'https://api.ghostnet.tzkt.io',
};

export const saplingStateMapContract = {
  mainnet: 'KT1WorWEWjfQqQ1X2BFQiCc4hE3DuDKQVH4U',
  ghostnet: 'KT1WorWEWjfQqQ1X2BFQiCc4hE3DuDKQVH4U',
};

type OrderedTransactionList = [
  // FA2 update_operators add_operator
  ContractMethodObject<Wallet>[],
  // FA1.2 approve
  ContractMethodObject<Wallet>[],
  // Default transactions
  {
    txns: string[];
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
} & (
  | { saplingSecret: string; saplingMnemonic?: never }
  | { saplingSecret?: never; saplingMnemonic: string }
);

const MINIMAL_FEE_MUTEZ = 100;
const MINIMAL_FEE_PER_BYTE_MUTEZ = 1;
const MINIMAL_FEE_PER_GAS_MUTEZ = 0.1;

export default class ShieldBridgeSDK {
  private tezosClient: TezosToolkit;

  saplingStateMapContract: string;

  minConfirmations: number;

  gasLimitBuffer: number;

  storageLimitBuffer: number;

  constructor(private config: ShieldBridgeSDKConfig) {
    this.tezosClient = config.client;
    this.minConfirmations = config.minConfirmations || 1;
    this.saplingStateMapContract =
      config.saplingStateMapContract || saplingStateMapContract.mainnet;
    this.gasLimitBuffer = config.gasLimitBuffer || 2_000;
    this.storageLimitBuffer = config.storageLimitBuffer || 350;
    // This prevents multiple instances with a separate baseUrl since the SDK is a singleton
    defaults.baseUrl = tzktApiMap[this.config.tzktApi || 'mainnet'];
  }

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

  getTokenDecimals = async (contract: string, tokenId?: number) => {
    const { decimals } = (await this.getTokenMetadata(contract, tokenId)) as {
      name?: string;
      symbol?: string;
      decimals: string;
    };
    return parseInt(decimals, 10);
  };

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
          txns: string[];
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

    const estimateBatch: withKind<TransferParams, OpKind.TRANSACTION>[] =
      batch.map(([operation, params = {}]) => ({
        kind: OpKind.TRANSACTION,
        // @ts-ignore string is an acceptible type for amount
        ...operation.toTransferParams(params),
      }));

    return this.tezosClient.estimate.batch(estimateBatch);
  };

  getEstimatedFee = (estimate: Estimate) => {
    const operationFeeMutez =
      (estimate.gasLimit + this.gasLimitBuffer) * MINIMAL_FEE_PER_GAS_MUTEZ +
      Number(estimate.opSize) * MINIMAL_FEE_PER_BYTE_MUTEZ;

    return Math.ceil(Number(operationFeeMutez + MINIMAL_FEE_MUTEZ * 1.2));
  };

  submitSaplingShieldTransaction = async (
    saplingDeposits: {
      amount: number | string;
      saplingTransactions: string[];
      owner?: string;
      contract?: string;
      tokenId?: number;
    }[],
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
          txns: string[];
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
            gasLimit: (estimate as Estimate).gasLimit + this.gasLimitBuffer,
            storageLimit:
              (estimate as Estimate).storageLimit + this.storageLimitBuffer,
            fee: this.getEstimatedFee(estimate as Estimate),
          });
        }
        // If token deposits are present, batch them separately from tez deposits
        if (nonTezTransactions.length) {
          const estimate = estimates.shift();
          batch.withContractCall(
            dappContract.methodsObject.default(nonTezTransactions),
            {
              gasLimit: (estimate as Estimate).gasLimit + this.gasLimitBuffer,
              storageLimit:
                (estimate as Estimate).storageLimit + this.storageLimitBuffer,
              fee: this.getEstimatedFee(estimate as Estimate),
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

  submitSaplingUnshieldTransaction = async (
    saplingWithdrawals: {
      saplingTransactions: string[];
      contract?: string;
      tokenId?: number;
    }[],
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

  submitSaplingTransferTransaction = async (
    saplingTransfers: {
      saplingTransactions: string[];
      contract?: string;
      tokenId?: number;
    }[],
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

  shield = async (
    shieldParams: {
      amount: number;
      shieldedAddress?: string;
      contract?: string;
      tokenId?: number;
      memo?: string;
    }[],
  ) => {
    const shieldParamPromises = shieldParams.map(async (shieldParam) => {
      const { amount, shieldedAddress, contract, tokenId, memo } = shieldParam;

      const saplingWorker = await spawn(new Worker('./saplingWorker.js'));

      const saplingId = await this.getSaplingId(contract, tokenId);
      if (!saplingId) {
        throw new Error('Sapling state not initialized for the token');
      }

      const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';
      await saplingWorker.loadSaplingSecret({
        sk:
          skType === 'secretKey'
            ? this.config.saplingSecret
            : this.config.saplingMnemonic,
        skType,
        saplingDetails: {
          contractAddress: this.saplingStateMapContract,
          memoSize: 8,
          saplingId,
        },
        rpcUrl: this.tezosClient.rpc.getRpcUrl(),
      });

      // Default token decimals
      let tokenDecimals = 6;
      if (contract) {
        tokenDecimals = await this.getTokenDecimals(contract, tokenId);
      }

      const unitAmount = new BigNumber(10)
        .exponentiatedBy(tokenDecimals)
        .times(amount)
        .toString();

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

      await Thread.terminate(saplingWorker);

      const owner = await this.tezosClient.wallet.pkh();

      return {
        saplingTransactions: [saplingTxn],
        owner,
        amount: unitAmount,
        contract,
        tokenId,
      };
    });

    const contractParams = (await Promise.all(shieldParamPromises)) as {
      saplingTransactions: string[];
      owner: string;
      amount: number | string;
      contract?: string;
      tokenId?: number;
    }[];

    return this.submitSaplingShieldTransaction(contractParams);
  };

  unshield = async (
    unshieldParams: {
      amount: number;
      unshieldedAddress?: string;
      contract?: string;
      tokenId?: number;
    }[],
  ) => {
    const unshieldParamPromises = unshieldParams.map(async (unshieldParam) => {
      const { amount, unshieldedAddress, contract, tokenId } = unshieldParam;

      const saplingWorker = await spawn(new Worker('./saplingWorker.js'));

      const saplingId = await this.getSaplingId(contract, tokenId);

      const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';
      await saplingWorker.loadSaplingSecret({
        sk:
          skType === 'secretKey'
            ? this.config.saplingSecret
            : this.config.saplingMnemonic,
        skType,
        saplingDetails: {
          contractAddress: this.saplingStateMapContract,
          memoSize: 8,
          saplingId,
        },
        rpcUrl: this.tezosClient.rpc.getRpcUrl(),
      });

      // Default token decimals
      let tokenDecimals = 6;
      if (contract) {
        tokenDecimals = await this.getTokenDecimals(contract, tokenId);
      }

      const unitAmount = new BigNumber(10)
        .exponentiatedBy(tokenDecimals)
        .times(amount)
        .toString();

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

      await Thread.terminate(saplingWorker);

      return {
        saplingTransactions: [saplingTxn],
        contract,
        tokenId,
      };
    });

    const contractParams = (await Promise.all(unshieldParamPromises)) as {
      saplingTransactions: string[];
      contract?: string;
      tokenId?: number;
    }[];

    return this.submitSaplingUnshieldTransaction(contractParams);
  };

  transfer = async (
    transferParams: {
      contract?: string;
      tokenId?: number;
      transfers: {
        amount: number;
        to: string;
        memo?: string;
      }[];
    }[],
  ) => {
    const transferParamPromises = transferParams.map(async (transferParam) => {
      const { contract, tokenId, transfers } = transferParam;

      const saplingWorker = await spawn(new Worker('./saplingWorker.js'));

      const saplingId = await this.getSaplingId(contract, tokenId);

      const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';
      await saplingWorker.loadSaplingSecret({
        sk:
          skType === 'secretKey'
            ? this.config.saplingSecret
            : this.config.saplingMnemonic,
        skType,
        saplingDetails: {
          contractAddress: this.saplingStateMapContract,
          memoSize: 8,
          saplingId,
        },
        rpcUrl: this.tezosClient.rpc.getRpcUrl(),
      });

      // Default token decimals
      let tokenDecimals = 6;
      if (contract) {
        tokenDecimals = await this.getTokenDecimals(contract, tokenId);
      }

      const saplingTransfers = transfers.map(({ amount, to, memo }) => {
        const unitAmount = new BigNumber(10)
          .exponentiatedBy(tokenDecimals)
          .times(amount)
          .toString();

        return {
          to,
          amount: unitAmount,
          memo,
          mutez: true,
        };
      });

      const saplingTxn =
        await saplingWorker.prepareSaplingTransaction(saplingTransfers);

      await Thread.terminate(saplingWorker);

      return {
        saplingTransactions: [saplingTxn],
        contract,
        tokenId,
      };
    });

    const contractParams = (await Promise.all(transferParamPromises)) as {
      saplingTransactions: string[];
      contract?: string;
      tokenId?: number;
    }[];

    return this.submitSaplingTransferTransaction(contractParams);
  };

  getShieldedBalance = async ({
    saplingId,
    contract,
    tokenId,
  }: {
    saplingId?: number;
    contract?: string;
    tokenId?: number;
  }): Promise<number> => {
    const saplingWorker = await spawn(new Worker('./saplingWorker.js'));

    let saplingIdQuery = saplingId;
    if (!saplingIdQuery) {
      saplingIdQuery = await this.getSaplingId(contract, tokenId);
    }

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';
    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret
          : this.config.saplingMnemonic,
      skType,
      saplingDetails: {
        contractAddress: this.saplingStateMapContract,
        memoSize: 8,
        saplingId: saplingIdQuery,
      },
      rpcUrl: this.tezosClient.rpc.getRpcUrl(),
    });

    const balance = await saplingWorker.getSaplingBalance();

    await Thread.terminate(saplingWorker);

    return balance;
  };

  getAllShieldedBalances = async () => {
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

    return Promise.all(
      saplingIds.map(async (saplingToken) => {
        const balance = await this.getShieldedBalance(saplingToken);
        return {
          balance,
          contract: saplingToken.contract,
          tokenId: saplingToken.tokenId,
        };
      }),
    );
  };

  getShieldedTransactions = async (contract?: string, tokenId?: number) => {
    const saplingWorker = await spawn(new Worker('./saplingWorker.js'));

    const saplingId = await this.getSaplingId(contract, tokenId);

    const skType = this.config.saplingSecret ? 'secretKey' : 'mnemonic';
    await saplingWorker.loadSaplingSecret({
      sk:
        skType === 'secretKey'
          ? this.config.saplingSecret
          : this.config.saplingMnemonic,
      skType,
      saplingDetails: {
        contractAddress: this.saplingStateMapContract,
        memoSize: 8,
        saplingId,
      },
      rpcUrl: this.tezosClient.rpc.getRpcUrl(),
    });

    const transactions = (await saplingWorker.getSaplingTransactions()) as {
      incoming: {
        isSpent: boolean;
        value: number;
        memo?: string;
        paymentAddress: string;
      }[];
      outgoing: {
        value: number;
        memo?: string;
        paymentAddress: string;
      }[];
    };

    await Thread.terminate(saplingWorker);

    return transactions;
  };
}
