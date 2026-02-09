import { expose } from 'threads/worker';

import { RpcReadAdapter } from '@tezos-x/octez.js';
import {
  SaplingToolkit,
  InMemorySpendingKey,
  InMemoryViewingKey,
  SaplingTransactionViewer,
} from '@tezos-x/octez.js-sapling';
import { RpcClient } from '@tezos-x/octez.js-rpc';
import { PrefixV2, b58Encode } from '@tezos-x/octez.js-utils';
import * as sapling from '@airgap/sapling-wasm';
import * as bip39 from 'bip39';

import {
  SaplingContractDetails,
  ParametersSaplingTransaction,
  ParametersUnshieldedTransaction,
} from '@tezos-x/octez.js-sapling/dist/types/types';

const SECRET_KEY_METHOD = 'secretKey';
const MNEMONIC_METHOD = 'mnemonic';
const VIEWING_KEY_METHOD = 'viewingKey';

// CDN URLs for sapling parameters (lazy loading)
// Host these files on your own CDN with CORS enabled
// Download from: https://download.z.cash/downloads/
const SAPLING_PARAMS_URLS = {
  spend: 'https://cdn.shieldbridge.xyz/sapling/sapling-spend.params',
  output: 'https://cdn.shieldbridge.xyz/sapling/sapling-output.params',
};

let iMSK: InMemorySpendingKey | null;
let iMVK: InMemoryViewingKey | null;
let sTk: SaplingToolkit | null;
let isViewOnly: boolean = false;
let currentSaplingDetails: SaplingContractDetails | null = null;
let currentRpcAdapter: RpcReadAdapter | null = null;

// Track if sapling parameters have been initialized (for lazy loading)
let saplingParamsInitialized = false;
let saplingParamsLoading: Promise<void> | null = null;

/**
 * Fetch sapling parameters from CDN
 * Used for lazy loading when params are not bundled
 */
async function fetchParams(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch params from ${url}: ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Initialize sapling parameters (lazy load from CDN if not bundled)
 * Called automatically before any proof generation
 */
const initSaplingParams = async (): Promise<void> => {
  if (saplingParamsInitialized) {
    return;
  }

  if (saplingParamsLoading) {
    return saplingParamsLoading;
  }

  saplingParamsLoading = (async () => {
    try {
      console.log('Loading sapling parameters from CDN...');
      const startTime = Date.now();

      // Load both params in parallel
      const [spendParams, outputParams] = await Promise.all([
        fetchParams(SAPLING_PARAMS_URLS.spend),
        fetchParams(SAPLING_PARAMS_URLS.output),
      ]);

      // Initialize the sapling library with the params
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

/**
 * Check if sapling params are loaded
 */
const areSaplingParamsLoaded = (): boolean => saplingParamsInitialized;

/**
 * Preload sapling params (call early to reduce latency)
 */
const preloadSaplingParams = (): void => {
  initSaplingParams().catch(console.error);
};

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
  try {
    const secretKey = sk;
    const loadAccountMethod = skType;

    // Reset previous state
    iMSK = null;
    iMVK = null;
    isViewOnly = false;

    if (loadAccountMethod === SECRET_KEY_METHOD) {
      iMSK = new InMemorySpendingKey(secretKey);
    } else if (loadAccountMethod === MNEMONIC_METHOD) {
      iMSK = await InMemorySpendingKey.fromMnemonic(secretKey);
    } else if (loadAccountMethod === VIEWING_KEY_METHOD) {
      iMVK = new InMemoryViewingKey(secretKey);
      isViewOnly = true;
    } else {
      throw new Error('Invalid account loading method provided');
    }

    // Store sapling details and RPC adapter for later use
    currentSaplingDetails = saplingDetails;
    currentRpcAdapter = new RpcReadAdapter(new RpcClient(rpcUrl));
  } catch (err) {
    iMSK = null;
    iMVK = null;
    sTk = null;
    isViewOnly = false;
    currentSaplingDetails = null;
    currentRpcAdapter = null;
    throw err;
  }

  try {
    // Create toolkit - only works with spending key for transactions
    if (!isViewOnly) {
      sTk = new SaplingToolkit(
        { saplingSigner: iMSK! },
        saplingDetails,
        currentRpcAdapter,
      );
    } else {
      // For view-only mode, we don't need SaplingToolkit for transactions
      // The viewing key will be used directly for balance and transaction queries
      sTk = null;
    }
  } catch (err) {
    iMSK = null;
    iMVK = null;
    sTk = null;
    isViewOnly = false;
    currentSaplingDetails = null;
    currentRpcAdapter = null;
    throw err;
  }
};

const getViewingKey = async (): Promise<string> => {
  if (isViewOnly && iMVK) {
    // Already have viewing key, return it as hex string
    const fvk = iMVK.getFullViewingKey();
    return Buffer.from(fvk).toString('hex');
  }

  if (iMSK) {
    // Get viewing key from spending key
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
  // Ensure sapling params are loaded before generating proof
  await initSaplingParams();
  return sTk!.prepareShieldedTransaction(shieldTransactions);
};

const prepareUnshieldedTransaction = async (
  unshieldTransaction: ParametersUnshieldedTransaction,
) => {
  if (isViewOnly) {
    throw new Error(
      'Cannot prepare transactions with a viewing key. A spending key is required.',
    );
  }
  // Ensure sapling params are loaded before generating proof
  await initSaplingParams();
  return sTk!.prepareUnshieldedTransaction(unshieldTransaction);
};

const prepareSaplingTransaction = async (
  saplingTransactions: ParametersSaplingTransaction[] = [],
) => {
  if (isViewOnly) {
    throw new Error(
      'Cannot prepare transactions with a viewing key. A spending key is required.',
    );
  }
  // Ensure sapling params are loaded before generating proof
  await initSaplingParams();
  return sTk!.prepareSaplingTransaction(saplingTransactions);
};

const getSaplingBalance = async () => {
  let txViewer: SaplingTransactionViewer;

  if (isViewOnly && iMVK) {
    // Create transaction viewer from viewing key
    if (!currentSaplingDetails || !currentRpcAdapter) {
      throw new Error('Sapling details not initialized');
    }
    const saplingContractId = currentSaplingDetails.saplingId
      ? { saplingId: currentSaplingDetails.saplingId }
      : { contractAddress: currentSaplingDetails.contractAddress };
    txViewer = new SaplingTransactionViewer(
      iMVK,
      saplingContractId,
      currentRpcAdapter,
    );
  } else if (sTk) {
    txViewer = await sTk.getSaplingTransactionViewer();
  } else {
    throw new Error('No sapling toolkit or viewing key available');
  }

  const balance = await txViewer.getBalance();
  return balance.toNumber();
};

const getSaplingTransactions = async () => {
  let txViewer: SaplingTransactionViewer;

  if (isViewOnly && iMVK) {
    // Create transaction viewer from viewing key
    if (!currentSaplingDetails || !currentRpcAdapter) {
      throw new Error('Sapling details not initialized');
    }
    const saplingContractId = currentSaplingDetails.saplingId
      ? { saplingId: currentSaplingDetails.saplingId }
      : { contractAddress: currentSaplingDetails.contractAddress };
    txViewer = new SaplingTransactionViewer(
      iMVK,
      saplingContractId,
      currentRpcAdapter,
    );
  } else if (sTk) {
    txViewer = await sTk.getSaplingTransactionViewer();
  } else {
    throw new Error('No sapling toolkit or viewing key available');
  }

  const transactionHistory =
    await txViewer.getIncomingAndOutgoingTransactions();
  return {
    incoming: transactionHistory.incoming.map((tx) => ({
      ...tx,
      value: tx.value.toNumber(),
    })),
    outgoing: transactionHistory.outgoing.map((tx) => ({
      ...tx,
      value: tx.value.toNumber(),
    })),
  };
};

const reInitializeSapling = () => {
  iMSK = null;
  sTk = null;
};

const saplingWorker = {
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
  // Lazy loading methods for optimized builds
  initSaplingParams,
  areSaplingParamsLoaded,
  preloadSaplingParams,
};

export type SaplingWorker = typeof saplingWorker;

expose(saplingWorker);
