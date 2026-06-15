import { ContractMethodObject, TezosToolkit, Wallet } from '@tezos-x/octez.js';
import BigNumber from 'bignumber.js';
import type { SaplingDiffStore } from './saplingDiffCache.js';

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
  /**
   * Token decimals, if the caller already knows them (e.g. from its own asset metadata). When
   * provided, the SDK uses this to convert the balance to display units and SKIPS the per-token
   * TzKT `/v1/tokens` decimals lookup. Omit to have the SDK fetch them (FA1.2/FA2); ignored for XTZ.
   */
  decimals?: number;
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
  /**
   * Incremental sapling-diff cache for balance/transaction reads. When enabled (default), the
   * viewer fetches only the diff delta (a persisted finalized prefix + the fresh unconfirmed
   * tail) instead of the full pool diff on every read — far less RPC traffic, especially as a
   * pool grows. The decrypt/spend path is unchanged, so balances are identical. In the browser
   * it persists to IndexedDB automatically; in Node/Lambda supply `saplingDiffStore`.
   * @default true
   */
  saplingDiffCache?: boolean;
  /**
   * Persistent store backing the diff cache (Node/Lambda/tests). The browser auto-uses
   * IndexedDB; supply this (e.g. `new MemoryDiffStore()`) to enable caching elsewhere.
   * Only applied in direct-execution mode (parallelThreads: false).
   */
  saplingDiffStore?: SaplingDiffStore;
  /**
   * Incremental balance cache ("v2") — also caches DECRYPTED notes and decrypts only the
   * commitments added since the last scan (O(new) instead of O(pool)). OPT-IN (default false):
   * it reimplements the balance sum, so it is guarded by a runtime self-check that compares
   * against a full stock balance every few scans and falls back on any divergence. Requires
   * `saplingDiffCache` (the fetch layer) and a store. The cache holds decrypted data, so call
   * `clearShieldedBalanceCache()` when forgetting an account.
   * @default false
   */
  saplingBalanceCache?: boolean;
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
