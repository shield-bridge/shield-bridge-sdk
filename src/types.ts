import { ContractMethodObject, TezosToolkit, Wallet } from '@tezos-x/octez.js';
import BigNumber from 'bignumber.js';

/**
 * Contract architecture version for the SDK
 * - '2': Factory contract with individual set contracts (recommended)
 * - '1': Legacy map contract with inline sapling states (deprecated)
 */
export type ContractArchitecture = '1' | '2';

/**
 * Supported amount input types for transaction operations.
 * Accepts number, string, or BigNumber.
 */
export type AmountInput = number | string | BigNumber;

// ---------------------------------------------------------------------------
// Public parameter types
// ---------------------------------------------------------------------------

export interface ShieldParams {
  amount: AmountInput;
  shieldedAddress?: string;
  contract?: string;
  tokenId?: number;
  memo?: string;
}

export interface UnshieldParams {
  amount: AmountInput;
  unshieldedAddress?: string;
  contract?: string;
  tokenId?: number;
}

export interface TransferParams {
  contract?: string;
  tokenId?: number;
  transfers: {
    amount: AmountInput;
    to: string;
    memo?: string;
  }[];
}

export interface SaplingTokenInfo {
  setAddress?: string;
  contract?: string;
  tokenId?: number;
}

/**
 * Progress callbacks for transaction operations.
 * Provides real-time updates during shield, unshield, and transfer operations.
 *
 * @example
 * await shieldBridge.shield([{ amount: 1, contract: 'KT1...' }], {
 *   onGenerating: (data) => console.log(`Generating sapling transaction`),
 *   onSigning: () => console.log('Signing transaction...'),
 *   onSubmitting: () => console.log('Submitting to network...'),
 *   onConfirmed: (data) => console.log(`Confirmed! Op: ${data.opHash}`)
 * });
 */
export interface TransactionProgressCallbacks {
  /** Called when preparing transaction parameters and generating sapling proofs */
  onGenerating?: (
    params: ShieldParams[] | TransferParams[] | UnshieldParams[],
  ) => void;
  /** Called when signing the transaction */
  onSigning?: () => void;
  /** Called when submitting to the network */
  onSubmitting?: (data: { opHash: string }) => void;
  /** Called when transaction is confirmed */
  onConfirmed?: (data: {
    opHash: string;
    block?: {
      block: unknown;
      expectedConfirmation: number;
      currentConfirmation: number;
      completed: boolean;
    };
  }) => void;
}

// ---------------------------------------------------------------------------
// SDK configuration
// ---------------------------------------------------------------------------

export type ShieldBridgeSDKConfig = {
  client: TezosToolkit;
  tzktApi?: 'mainnet' | 'shadownet';
  minConfirmations?: number;
  /**
   * Contract architecture version
   * - '2' (default): Factory contract with individual set contracts
   * - '1': Legacy map contract with inline sapling states
   * @deprecated V1 is for migration only. Use V2 for new integrations.
   */
  contractArchitecture?: ContractArchitecture;
  /** Shield Bridge contract address (V2 factory or V1 map depending on architecture) */
  shieldBridgeContract?: string;
  /** @deprecated Use shieldBridgeContract instead */
  saplingFactoryContract?: string;
  /** @deprecated Use shieldBridgeContract instead */
  saplingMapContract?: string;
  /** @deprecated Use shieldBridgeContract instead */
  saplingStateMapContract?: string;
  useBaseUnits?: boolean;
  /**
   * Whether to use parallel workers for proof generation.
   * - true (default): spawns parallel workers for concurrent proof generation
   * - number: explicit maximum concurrency cap
   * - false: sequential single-worker mode
   */
  parallelThreads?: boolean | number;
  /**
   * Custom base URL for sapling params files.
   * By default, the SDK loads sapling-spend.params and sapling-output.params
   * from the same directory as the worker script.
   * Set this to override, e.g. '/assets/sapling/' or 'https://cdn.example.com/sapling/'
   */
  saplingParamsUrl?: string;
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

// ---------------------------------------------------------------------------
// Factory storage types (for Taquito RPC responses)
// ---------------------------------------------------------------------------

/** Factory contract storage shape as returned by Taquito */
export interface FactoryStorage {
  tez: string;
  token_fa_1_2: {
    get(contract: string): Promise<string | undefined>;
  };
  token_fa_2: {
    get(key: {
      contract: string;
      token_id: number;
    }): Promise<string | undefined>;
  } & number; // big_map ID is also a number for TzKT queries
  registered_sets: unknown;
}

/** Asset info returned by getAllShieldedAssets */
export interface ShieldedAssetInfo {
  setAddress: string;
  contract?: string;
  tokenId?: number;
  metadata?: TokenMetadata;
}

/** Token metadata from TzKT */
export interface TokenMetadata {
  name?: string;
  symbol?: string;
  decimals?: string;
  thumbnailUri?: string;
  [key: string]: string | undefined;
}

/** TzKT token balance response */
export interface TzKTTokenBalance {
  balance: string;
  token?: {
    metadata?: TokenMetadata;
    contract?: { address: string };
    tokenId?: string;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal transaction format for the V1 map contract (legacy).
 * @deprecated V1 is for migration only. V2 calls Set contracts directly.
 * @internal
 */
export type FactoryTransactionItem = {
  txns: (string | undefined)[];
  contract?: string;
  token_id?: number;
  amount?: AmountInput;
};

/** @internal */
export type OrderedTransactionList = [
  // FA2 update_operators add_operator
  ContractMethodObject<Wallet>[],
  // FA1.2 approve
  ContractMethodObject<Wallet>[],
  // Default transactions
  FactoryTransactionItem[],
  // FA2 update_operators remove_operator
  ContractMethodObject<Wallet>[],
];

/** @internal */
export interface SaplingDeposits {
  amount: AmountInput;
  saplingTransactions: string[];
  owner?: string;
  contract?: string;
  tokenId?: number;
}

/** @internal */
export interface SaplingTransactions {
  saplingTransactions: string[];
  contract?: string;
  tokenId?: number;
}

/** @internal */
export enum OperationIndex {
  UPDATE_OPERATORS_ADD_INDEX = 0,
  APPROVE_INDEX = 1,
  DEFAULT_INDEX = 2,
  UPDATE_OPERATORS_REMOVE_INDEX = 3,
}

// ---------------------------------------------------------------------------
// Worker-related types (shared between index.ts and worker.ts)
// ---------------------------------------------------------------------------

export interface SaplingContractDetails {
  contractAddress: string;
  memoSize: number;
  saplingId?: string;
}

export interface ParametersSaplingTransaction {
  to: string;
  amount: AmountInput;
  memo?: string;
  mutez?: boolean;
}

export interface ParametersUnshieldedTransaction {
  to: string;
  amount: AmountInput;
  mutez?: boolean;
}

export interface LoadSaplingSecretParams {
  sk: string;
  skType: 'secretKey' | 'mnemonic' | 'viewingKey';
  saplingDetails: SaplingContractDetails;
  rpcUrl: string;
}
