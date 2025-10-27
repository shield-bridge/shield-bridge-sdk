import { expose } from 'threads/worker';

import { RpcReadAdapter } from '@taquito/taquito';
import { SaplingToolkit, InMemorySpendingKey } from '@taquito/sapling';
import { RpcClient } from '@taquito/rpc';
import { PrefixV2, b58Encode } from '@taquito/utils';
import * as sapling from '@airgap/sapling-wasm';
import * as bip39 from 'bip39';

import {
  SaplingContractDetails,
  ParametersSaplingTransaction,
  ParametersUnshieldedTransaction,
} from '@taquito/sapling/dist/types/types';

const SECRET_KEY_METHOD = 'secretKey';
const MNEMONIC_METHOD = 'mnemonic';

let iMSK: InMemorySpendingKey | null;
let sTk: SaplingToolkit | null;

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
  skType: 'secretKey' | 'mnemonic';
}) => {
  try {
    const secretKey = sk;
    const loadAccountMethod = skType;

    if (loadAccountMethod === SECRET_KEY_METHOD) {
      iMSK = new InMemorySpendingKey(secretKey);
    } else if (loadAccountMethod === MNEMONIC_METHOD) {
      iMSK = await InMemorySpendingKey.fromMnemonic(secretKey);
    } else {
      throw new Error('Invalid account loading method provided');
    }
  } catch (err) {
    iMSK = null;
    sTk = null;
    throw err;
  }

  try {
    sTk = new SaplingToolkit(
      { saplingSigner: iMSK },
      saplingDetails,
      new RpcReadAdapter(new RpcClient(rpcUrl)),
    );
  } catch (err) {
    iMSK = null;
    sTk = null;
    throw err;
  }
};

const getPaymentAddress = () =>
  iMSK!
    .getSaplingViewingKeyProvider()
    .then((inMemoryViewingKey) => inMemoryViewingKey.getAddress());

const prepareShieldedTransaction = (
  shieldTransactions: ParametersSaplingTransaction[],
) => sTk!.prepareShieldedTransaction(shieldTransactions);

const prepareUnshieldedTransaction = (
  unshieldTransaction: ParametersUnshieldedTransaction,
) => sTk!.prepareUnshieldedTransaction(unshieldTransaction);

const prepareSaplingTransaction = (
  saplingTransactions: ParametersSaplingTransaction[] = [],
) => sTk!.prepareSaplingTransaction(saplingTransactions);

const getSaplingBalance = () =>
  sTk!
    .getSaplingTransactionViewer()
    .then((txViewer) =>
      txViewer.getBalance().then((balance) => balance.toNumber()),
    );

const getSaplingTransactions = () =>
  sTk!
    .getSaplingTransactionViewer()
    .then((txViewer) => txViewer.getIncomingAndOutgoingTransactions())
    .then((transactionHistory) => ({
      incoming: transactionHistory.incoming.map((tx) => ({
        ...tx,
        value: tx.value.toNumber(),
      })),
      outgoing: transactionHistory.outgoing.map((tx) => ({
        ...tx,
        value: tx.value.toNumber(),
      })),
    }));

const reInitializeSapling = () => {
  iMSK = null;
  sTk = null;
};

const saplingWorker = {
  createExtendedSpendingKey,
  loadSaplingSecret,
  getPaymentAddress,
  prepareShieldedTransaction,
  prepareUnshieldedTransaction,
  prepareSaplingTransaction,
  getSaplingBalance,
  getSaplingTransactions,
  reInitializeSapling,
};

export type SaplingWorker = typeof saplingWorker;

expose(saplingWorker);
