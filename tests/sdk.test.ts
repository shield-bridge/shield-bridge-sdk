import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock comlink before importing the SDK
// vi.hoisted ensures these are available to vi.mock factories (which are hoisted)
const { RELEASE_PROXY } = vi.hoisted(() => {
  const RELEASE_PROXY = Symbol('Comlink.releaseProxy');
  return { RELEASE_PROXY };
});

vi.mock('comlink', () => {
  return {
    default: {
      wrap: vi.fn(),
      releaseProxy: RELEASE_PROXY,
    },
    wrap: vi.fn(),
    releaseProxy: RELEASE_PROXY,
  };
});

// Mock worker_threads to prevent actual worker spawning in Node.js
vi.mock('worker_threads', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    postMessage: vi.fn(),
    terminate: vi.fn(),
  })),
}));

// Mock the worker module
vi.mock('../src/worker', () => ({}));

import * as Comlink from 'comlink';
import { shieldBridgeContract, saplingMapContract } from '../src/constants';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to create minimal mock objects
// ─────────────────────────────────────────────────────────────────────────────

function createMockSaplingWorker() {
  const worker: Record<string | symbol, any> = {
    loadSaplingSecret: vi.fn().mockResolvedValue(undefined),
    getPaymentAddress: vi
      .fn()
      .mockResolvedValue({ address: 'zet1mock...address' }),
    getViewingKey: vi.fn().mockResolvedValue('mock-viewing-key-hex'),
    getBalance: vi.fn().mockResolvedValue('0'),
    getIncomingAndOutgoingTransactions: vi.fn().mockResolvedValue({
      incoming: [],
      outgoing: [],
    }),
    prepareShieldedTransaction: vi.fn().mockResolvedValue('mock-shielded-tx'),
    prepareUnshieldedTransaction: vi
      .fn()
      .mockResolvedValue('mock-unshielded-tx'),
    prepareSaplingTransaction: vi.fn().mockResolvedValue('mock-sapling-tx'),
    setSaplingParamsUrl: vi.fn().mockResolvedValue(undefined),
    setSaplingParamsUrls: vi.fn().mockResolvedValue(undefined),
    setDiffCacheEnabled: vi.fn().mockResolvedValue(undefined),
    setBalanceCacheEnabled: vi.fn().mockResolvedValue(undefined),
    setDiffCacheStore: vi.fn().mockResolvedValue(undefined),
    clearShieldedBalanceCache: vi.fn().mockResolvedValue(undefined),
    preloadSaplingParams: vi.fn().mockResolvedValue(undefined),
  };
  worker[RELEASE_PROXY] = vi.fn();
  return worker;
}

function createMockTezosClient() {
  return {
    wallet: {
      at: vi.fn().mockResolvedValue({
        methodsObject: {
          default: vi.fn().mockReturnValue({
            toTransferParams: vi.fn().mockReturnValue({
              to: 'KT1...',
              amount: 0,
              parameter: { entrypoint: 'default', value: {} },
            }),
            send: vi.fn(),
          }),
        },
        storage: vi.fn(),
        contractViews: {},
      }),
      batch: vi.fn().mockReturnValue({
        withTransfer: vi.fn().mockReturnThis(),
        send: vi.fn().mockResolvedValue({
          opHash: 'oo_mock_hash',
          confirmation: vi.fn().mockResolvedValue({ block: {} }),
        }),
      }),
    },
    contract: {
      at: vi.fn().mockResolvedValue({
        methodsObject: {
          default: vi.fn().mockReturnValue({
            toTransferParams: vi.fn().mockReturnValue({
              to: 'KT1...',
              amount: 0,
              parameter: { entrypoint: 'default', value: {} },
            }),
          }),
        },
        storage: vi.fn(),
        contractViews: {},
      }),
    },
    rpc: {
      getRpcUrl: vi.fn().mockReturnValue('https://mainnet.api.tez.ie'),
    },
    estimate: {
      batch: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic import with mocked Worker constructor
// ─────────────────────────────────────────────────────────────────────────────

// We need to mock the Worker constructor to prevent actual worker spawning
// The SDK checks `typeof window` to decide browser vs node
// In vitest (node), it uses `require('worker_threads').Worker`

let ShieldBridgeSDK: any;
let mockWorkerInstance: ReturnType<typeof createMockSaplingWorker>;

beforeEach(async () => {
  mockWorkerInstance = createMockSaplingWorker();

  // Make Comlink.wrap return our mock worker
  vi.mocked(Comlink.wrap).mockReturnValue(mockWorkerInstance as any);

  // Re-import to get fresh module with mocks
  const mod = await import('../src/index');
  ShieldBridgeSDK = mod.ShieldBridgeSDK;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Constructor and Initialization
// =============================================================================
describe('ShieldBridgeSDK - Constructor', () => {
  it('creates an instance with minimal config', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic seed phrase',
    });

    expect(sdk).toBeDefined();
    expect(sdk.contractArchitecture).toBe('2'); // Default to V2
    expect(sdk.isViewOnlyMode).toBe(false);
    expect(sdk.ready).toBeInstanceOf(Promise);
  });

  it('defaults to mainnet V2 factory address', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    expect(sdk.shieldBridgeContractAddress).toBe(shieldBridgeContract.mainnet);
  });

  it('uses shadownet address when tzktApi is shadownet', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
      tzktApi: 'shadownet',
    });

    expect(sdk.shieldBridgeContractAddress).toBe(
      shieldBridgeContract.shadownet,
    );
  });

  it('V1 architecture uses saplingMapContract by default', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
      contractArchitecture: '1',
    });

    expect(sdk.contractArchitecture).toBe('1');
    expect(sdk.shieldBridgeContractAddress).toBe(saplingMapContract.mainnet);
  });

  it('accepts custom shieldBridgeContract address', () => {
    const client = createMockTezosClient();
    const customAddress = 'KT1CustomAddress123';
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
      shieldBridgeContract: customAddress,
    });

    expect(sdk.shieldBridgeContractAddress).toBe(customAddress);
  });

  it('sets view-only mode when saplingViewingKey is provided', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingViewingKey: 'mock-viewing-key',
    });

    expect(sdk.isViewOnlyMode).toBe(true);
  });

  it('defaults useBaseUnits to false', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    expect(sdk.useBaseUnits).toBe(false);
  });

  it('defaults parallelThreads to true', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    expect(sdk.parallelThreads).toBe(true);
  });

  it('defaults minConfirmations to 1', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    expect(sdk.minConfirmations).toBe(1);
  });

  it('deprecated saplingStateMapContract getter returns shieldBridgeContractAddress', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    expect(sdk.saplingStateMapContract).toBe(sdk.shieldBridgeContractAddress);
  });
});

// =============================================================================
// switchArchitecture
// =============================================================================
describe('ShieldBridgeSDK - switchArchitecture', () => {
  it('switches from V2 to V1', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    expect(sdk.contractArchitecture).toBe('2');

    sdk.switchArchitecture('1');

    expect(sdk.contractArchitecture).toBe('1');
    expect(sdk.shieldBridgeContractAddress).toBe(saplingMapContract.mainnet);
  });

  it('switches from V1 to V2', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
      contractArchitecture: '1',
    });

    sdk.switchArchitecture('2');

    expect(sdk.contractArchitecture).toBe('2');
    expect(sdk.shieldBridgeContractAddress).toBe(shieldBridgeContract.mainnet);
  });

  it('uses custom contract address when provided', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    const customAddr = 'KT1CustomSwitch';
    sdk.switchArchitecture('1', customAddr);

    expect(sdk.shieldBridgeContractAddress).toBe(customAddr);
  });

  it('throws when operations are in flight', async () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    // Simulate an in-flight operation by accessing the private field
    sdk.operationsInFlight = 2;

    expect(() => sdk.switchArchitecture('1')).toThrow(
      'Cannot switch architecture while 2 operation(s) are in flight',
    );
  });

  it('clears contract caches on switch', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    // Populate caches via private access
    sdk.walletContractCache.set('KT1test', {});
    sdk.estimatorContractCache.set('KT1test', {});

    sdk.switchArchitecture('1');

    expect(sdk.walletContractCache.size).toBe(0);
    expect(sdk.estimatorContractCache.size).toBe(0);
  });

  it('clears architecture-bound set-address caches on switch', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    // Set addresses (V2) and sapling IDs (V1) are resolved against the current
    // contract, so a switch must drop them to avoid stale promises that never
    // refetch. Token decimals/metadata are token-keyed and must survive.
    sdk.setAddressCache.set('tez', Promise.resolve('KT1oldSet'));
    sdk.saplingIdCache.set('tez', Promise.resolve(0));
    sdk.factoryStoragePromise = Promise.resolve({} as any);
    sdk.tokenDecimalsCache.set('KT1token', Promise.resolve(6));

    sdk.switchArchitecture('1');

    expect(sdk.setAddressCache.size).toBe(0);
    expect(sdk.saplingIdCache.size).toBe(0);
    expect(sdk.factoryStoragePromise).toBeNull();
    // Token-keyed caches are architecture-independent and preserved.
    expect(sdk.tokenDecimalsCache.size).toBe(1);
  });
});

// =============================================================================
// getArchitecture
// =============================================================================
describe('ShieldBridgeSDK - getArchitecture', () => {
  it('returns current architecture', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    expect(sdk.getArchitecture()).toBe('2');

    sdk.switchArchitecture('1');
    expect(sdk.getArchitecture()).toBe('1');
  });
});

// =============================================================================
// destroy
// =============================================================================
describe('ShieldBridgeSDK - destroy', () => {
  it('clears all caches', async () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    await sdk.ready;

    // Populate caches
    sdk.setAddressCache.set('key', Promise.resolve('addr'));
    sdk.saplingIdCache.set('key', Promise.resolve(0));
    sdk.tokenDecimalsCache.set('key', Promise.resolve(6));
    sdk.tokenMetadataCache.set('key', Promise.resolve({}));
    sdk.walletContractCache.set('key', {});
    sdk.estimatorContractCache.set('key', {});

    await sdk.destroy();

    expect(sdk.setAddressCache.size).toBe(0);
    expect(sdk.saplingIdCache.size).toBe(0);
    expect(sdk.tokenDecimalsCache.size).toBe(0);
    expect(sdk.tokenMetadataCache.size).toBe(0);
    expect(sdk.walletContractCache.size).toBe(0);
    expect(sdk.estimatorContractCache.size).toBe(0);
  });

  it('releases the sapling worker proxy', async () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    await sdk.ready;

    // In parallel mode the pool owns the workers (the standalone primary is no
    // longer spawned), so materialize one so destroy has something to release.
    const entry = await sdk.workerPool.checkout();
    sdk.workerPool.release(entry);

    await sdk.destroy();

    // The releaseProxy symbol should have been called on the worker
    expect(mockWorkerInstance[RELEASE_PROXY]).toHaveBeenCalled();
  });

  it('does not throw if worker is already terminated', async () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic',
    });

    await sdk.ready;

    const entry = await sdk.workerPool.checkout();
    sdk.workerPool.release(entry);

    // Make releaseProxy throw (simulating already terminated worker)
    mockWorkerInstance[RELEASE_PROXY] = vi.fn(() => {
      throw new Error('Worker terminated');
    });

    // Should not throw
    await expect(sdk.destroy()).resolves.not.toThrow();
  });
});

// =============================================================================
// getSaplingKeyInfo (private helper, tested via behavior)
// =============================================================================
describe('ShieldBridgeSDK - getSaplingKeyInfo', () => {
  it('returns secretKey type when saplingSecret is provided', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingSecret: 'sask_test_secret',
    });

    const { skType, sk } = sdk.getSaplingKeyInfo();
    expect(skType).toBe('secretKey');
    expect(sk).toBe('sask_test_secret');
  });

  it('returns viewingKey type when saplingViewingKey is provided', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingViewingKey: 'viewing_key_hex',
    });

    const { skType, sk } = sdk.getSaplingKeyInfo();
    expect(skType).toBe('viewingKey');
    expect(sk).toBe('viewing_key_hex');
  });

  it('returns mnemonic type when saplingMnemonic is provided', () => {
    const client = createMockTezosClient();
    const sdk = new ShieldBridgeSDK({
      client,
      saplingMnemonic: 'test mnemonic words',
    });

    const { skType, sk } = sdk.getSaplingKeyInfo();
    expect(skType).toBe('mnemonic');
    expect(sk).toBe('test mnemonic words');
  });
});

// =============================================================================
// formatTokenInfo (private static helper)
// =============================================================================
describe('ShieldBridgeSDK - formatTokenInfo', () => {
  it('returns "tez" for no contract', () => {
    expect(ShieldBridgeSDK.formatTokenInfo()).toBe('tez');
    expect(ShieldBridgeSDK.formatTokenInfo(undefined)).toBe('tez');
  });

  it('returns contract address for FA1.2 (no tokenId)', () => {
    expect(ShieldBridgeSDK.formatTokenInfo('KT1abc')).toBe('contract KT1abc');
  });

  it('returns contract + tokenId for FA2', () => {
    expect(ShieldBridgeSDK.formatTokenInfo('KT1abc', 0)).toBe(
      'contract KT1abc tokenId 0',
    );
    expect(ShieldBridgeSDK.formatTokenInfo('KT1abc', 42)).toBe(
      'contract KT1abc tokenId 42',
    );
  });
});

// =============================================================================
// Re-exports
// =============================================================================
describe('ShieldBridgeSDK - exports', () => {
  it('re-exports contract address constants', async () => {
    const mod = await import('../src/index');
    expect(mod.shieldBridgeContract).toBeDefined();
    expect(mod.saplingFactoryContract).toBe(mod.shieldBridgeContract);
    expect(mod.saplingMapContract).toBeDefined();
    expect(mod.saplingStateMapContract).toBe(mod.saplingMapContract);
  });
});
