<div align="center">

<img src="https://shieldbridge.xyz/logo.svg" alt="Shield Bridge Logo" width="200"/>

# Shield Bridge SDK

**A powerful TypeScript SDK for private transactions on Tezos using Sapling protocol**

[![npm version](https://img.shields.io/npm/v/shield-bridge-sdk.svg)](https://www.npmjs.com/package/shield-bridge-sdk) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org/)

[Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Documentation](#-documentation) • [Examples](#-examples)

</div>

---

## 📖 About

**Shield Bridge SDK** is a comprehensive TypeScript library that provides a simple, secure interface to interact with the Shield Bridge smart contract on Tezos. It enables users to shield their FA1.2 tokens, FA2 tokens, and tez into Sapling shielded pools for **private transactions**.

### 🎯 Why Shield Bridge?

- **🔒 Privacy**: All shielded transactions are obfuscated by the Sapling protocol
- **⚡ Efficiency**: Multiple sapling transactions in a single operation
- **🌐 Network Effects**: Single smart contract for all shielded pools
- **🔍 Auditability**: View-only mode for compliance and monitoring
- **📊 Real-time Updates**: Progress callbacks for transaction tracking

### ✨ Key Benefits

The Shield Bridge smart contract consolidates all underlying sapling shielded pools into a single contract, which:

- Encourages network effects and liquidity
- Reduces deployment overhead
- Enables batch operations across multiple tokens
- Simplifies the user experience

## 📚 Table of Contents

- [✨ Features](#-features)
- [📦 Installation](#-installation)
- [🚀 Quick Start](#-quick-start)
- [📘 Documentation](#-documentation)
  - [Initialization](#initialization)
  - [Shield Operations](#shield-operations)
  - [Unshield Operations](#unshield-operations)
  - [Transfer Operations](#transfer-operations)
  - [Query Operations](#query-operations)
  - [Factory View Methods](#factory-view-methods)
  - [V1/V2 Architecture Switching](#v1v2-architecture-switching)
  - [Progress Callbacks](#progress-callbacks)
  - [View-Only Mode](#view-only-mode)
  - [Operation Hash Tracking](#operation-hash-tracking)
- [💡 Examples](#-examples)
- [⚙️ Advanced Configuration](#️-advanced-configuration)
- [📦 Exported Types](#-exported-types)
- [🧪 Testing](#-testing)
- [❓ FAQ](#-faq)
- [📄 License](#-license)

## ✨ Features

- ✅ **Shield tokens** (FA1.2, FA2, and Tez) into Sapling pools
- ✅ **Unshield tokens** back to transparent addresses
- ✅ **Transfer** between shielded addresses privately
- ✅ **Batch operations** - multiple transactions in one call
- ✅ **View-only mode** - read-only access with viewing keys
- ✅ **Progress callbacks** - real-time transaction status updates
- ✅ **Operation tracking** - get operation hashes for all transactions
- ✅ **Query balances** - check shielded balances across all pools
- ✅ **Transaction history** - retrieve incoming/outgoing transactions
- ✅ **Factory views** - query on-chain registry (set addresses, registration status)
- ✅ **V1/V2 switching** - seamlessly switch between legacy and factory architectures
- ✅ **TypeScript support** - full type safety and IntelliSense
- ✅ **Flexible configuration** - customize confirmations, sapling-params URL, architecture, and more
- ✅ **Parallel proof generation** - enabled by default for faster operations
- ✅ **Incremental balance reads** - cached sapling-diff (default-on) + an opt-in decrypt-only-new layer; decrypted notes are encrypted at rest
- ✅ **Clean lifecycle** - `destroy()` method for SPA cleanup
- ✅ **Worker safety** - automatic cleanup of parallel workers on failure

## 📦 Installation

### Prerequisites

- Node.js >= v18
- npm or yarn

### Install via npm

```bash
npm install shield-bridge-sdk
```

### Install via yarn

```bash
yarn add shield-bridge-sdk
```

---

## 🚀 Quick Start

Get up and running in 3 simple steps:

### 1️⃣ Initialize the SDK

```typescript
import { TezosToolkit } from '@tezos-x/octez.js';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import { ShieldBridgeSDK } from 'shield-bridge-sdk';

const tezos = new TezosToolkit('https://mainnet.tezos.ecadinfra.com');
tezos.setSignerProvider(await InMemorySigner.fromSecretKey('edsk...'));

const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
});

// Wait for the SDK to initialize
await shieldBridge.ready;
```

### 2️⃣ Shield some tokens

```typescript
// Shield 5 tez into the shielded pool
const result = await shieldBridge.shield([{ amount: 5, memo: 'deposit' }]);
console.log(`Transaction confirmed! Op hash: ${result.opHash}`);
```

### 3️⃣ Check your balance

```typescript
const balance = await shieldBridge.getShieldedBalance({});
console.log('Shielded balance:', balance);
```

🎉 **That's it!** You're now using private transactions on Tezos.

> **Note:** `getShieldedBalance({})` takes a `SaplingTokenInfo` object — pass `{}` for XTZ, or `{ contract, tokenId }` for tokens.

---

## 📘 Documentation

### Initialization

The SDK supports three initialization modes:

#### Full Access Mode (with Spending Key)

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...', // Your sapling spending key
});
```

#### Full Access Mode (with Mnemonic)

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingMnemonic: 'word1 word2 word3 ...', // 24-word mnemonic
});
```

#### View-Only Mode (with Viewing Key)

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingViewingKey: 'abc123...', // Hex-encoded viewing key
});

console.log(shieldBridge.isViewOnlyMode); // true
```

> **Note**: View-only mode allows querying balances and transactions but **cannot perform shield/unshield/transfer operations**.

---

### Shield Operations

Shield (deposit) transparent tokens into the Sapling shielded pool for privacy.

#### Shield Tez

```typescript
const result = await shieldBridge.shield([
  {
    amount: 10, // Amount in tez (or mutez if useBaseUnits: true)
    memo: 'deposit', // Optional memo (max 8 chars)
  },
]);

console.log(`View on TzKT: https://tzkt.io/${result.opHash}`);
```

#### Shield FA2 Tokens

```typescript
const result = await shieldBridge.shield([
  {
    amount: 100,
    contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
    tokenId: 0,
    memo: 'fa2-shld',
  },
]);
```

#### Shield FA1.2 Tokens

```typescript
const result = await shieldBridge.shield([
  {
    amount: 50,
    contract: 'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
    memo: 'fa12shld',
  },
]);
```

#### Batch Shield (Multiple Assets at Once)

```typescript
const result = await shieldBridge.shield([
  { amount: 5 }, // 5 tez
  { amount: 100, contract: 'KT1...FA2...', tokenId: 0 }, // 100 FA2 tokens
  { amount: 50, contract: 'KT1...FA12...' }, // 50 FA1.2 tokens
]);

// All shielded in a single operation!
```

#### Shield to a Different Address

```typescript
const result = await shieldBridge.shield([
  {
    amount: 10,
    shieldedAddress: 'zet13iuD1bKNE5MAEXN4JfVEnSKHyoCAwUhGz...', // Recipient's shielded address
    memo: 'gift',
  },
]);
```

---

### Unshield Operations

Unshield (withdraw) tokens from the Sapling pool back to transparent addresses.

#### Unshield Tez

```typescript
const result = await shieldBridge.unshield([
  {
    amount: 3, // Amount to unshield
    // Unshields to your connected wallet address by default
  },
]);
```

#### Unshield to a Different Address

```typescript
const result = await shieldBridge.unshield([
  {
    amount: 3,
    unshieldedAddress: 'tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb', // Recipient
  },
]);
```

#### Unshield FA2 Tokens

```typescript
const result = await shieldBridge.unshield([
  {
    amount: 50,
    contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
    tokenId: 0,
  },
]);
```

#### Batch Unshield

```typescript
const result = await shieldBridge.unshield([
  { amount: 2 }, // Unshield 2 tez
  { amount: 30, contract: 'KT1...', tokenId: 0 }, // Unshield 30 FA2 tokens
]);
```

---

### Transfer Operations

Transfer tokens privately between shielded addresses (both sender and recipient remain private).

#### Simple Transfer

```typescript
const result = await shieldBridge.transfer([
  {
    transfers: [
      {
        amount: 1,
        to: 'zet13iuD1bKNE5MAEXN4JfVEnSKHyoCAwUhGzXFANZxmeof2DJXGX4F23jEW5zgf7LpdK',
        memo: 'payment',
      },
    ],
  },
]);
```

#### Multiple Recipients (Split Payment)

```typescript
const result = await shieldBridge.transfer([
  {
    transfers: [
      {
        amount: 1,
        to: 'zet13iuD1bKNE5...',
        memo: 'alice',
      },
      {
        amount: 2,
        to: 'zet13Kuz6erK5...',
        memo: 'bob',
      },
      {
        amount: 0.5,
        to: 'zet14abc123...',
        memo: 'charlie',
      },
    ],
  },
]);

// Sends to 3 different recipients in one transaction!
```

#### Transfer FA2 Tokens

```typescript
const result = await shieldBridge.transfer([
  {
    transfers: [
      {
        amount: 25,
        to: 'zet13iuD1bKNE5...',
        memo: 'tokens',
      },
    ],
    contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
    tokenId: 0,
  },
]);
```

#### Batch Transfer (Multiple Assets)

```typescript
const result = await shieldBridge.transfer([
  {
    // Transfer tez
    transfers: [{ amount: 1, to: 'zet13iuD1...' }],
  },
  {
    // Transfer FA2 tokens
    transfers: [{ amount: 50, to: 'zet13iuD1...' }],
    contract: 'KT1...',
    tokenId: 0,
  },
]);
```

---

### Query Operations

#### Get Shielded Balance

```typescript
// Get tez balance
const tezBalance = await shieldBridge.getShieldedBalance({});

// Get FA2 token balance
const fa2Balance = await shieldBridge.getShieldedBalance({
  contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
  tokenId: 0,
});

// Get FA1.2 token balance
const fa12Balance = await shieldBridge.getShieldedBalance({
  contract: 'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
});
```

> **Tip:** pass `setAddress` and/or `decimals` if you already know them (e.g. from your own asset
> list). The SDK uses them directly and skips the per-token factory/`/v1/tokens` lookups —
> meaningful when reading many balances at once.
>
> ```typescript
> const balance = await shieldBridge.getShieldedBalance({
>   contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
>   tokenId: 0,
>   setAddress: 'KT1...', // skips the factory set-address lookup
>   decimals: 8, // skips the /v1/tokens decimals lookup
> });
> ```

#### Get All Shielded Balances

```typescript
const balances = await shieldBridge.getAllShieldedBalances();

console.log(balances);
// [
//   { balance: 5.5, setAddress: 'KT1...' },
//   { balance: 100, setAddress: 'KT1...', contract: 'KT1...', tokenId: 0 },
//   { balance: 50, setAddress: 'KT1...', contract: 'KT1...' }
// ]
```

#### Get Transaction History

```typescript
// Get tez transaction history
const tezTxs = await shieldBridge.getShieldedTransactions();

// Get FA2 token transaction history
const fa2Txs = await shieldBridge.getShieldedTransactions(
  'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
  0,
);

// Get FA1.2 token transaction history
const fa12Txs = await shieldBridge.getShieldedTransactions(
  'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
);

console.log(tezTxs);
// {
//   incoming: [{ value: 5, memo: 'Received payment', position: '0' }],
//   outgoing: [{ value: 2, memo: 'Sent payment', position: '1' }]
// }
```

#### Get Shielded Address

```typescript
const shieldedAddress = await shieldBridge.getShieldedAddress();
console.log(`Your shielded address: ${shieldedAddress}`);
// zet13iuD1bKNE5MAEXN4JfVEnSKHyoCAwUhGzXFANZxmeof2DJXGX4F23jEW5zgf7LpdK
```

#### Get All Shielded Assets

```typescript
const assets = await shieldBridge.getAllShieldedAssets();

console.log(assets);
// [
//   { setAddress: 'KT1...' }, // Tez
//   { setAddress: 'KT1...', contract: 'KT1...', tokenId: 0, metadata: {...} }, // FA2
//   { setAddress: 'KT1...', contract: 'KT1...', metadata: {...} } // FA1.2
// ]
```

---

### Factory View Methods

Query the on-chain factory contract registry to discover set addresses and check registration status. These call Tezos on-chain views directly.

#### Get the Tez Set Address

```typescript
const tezSet = await shieldBridge.getTezSetAddress();
console.log(`Tez sapling set: ${tezSet}`);
// KT1...
```

#### Get an FA1.2 Token's Set Address

```typescript
const fa12Set = await shieldBridge.getFA12SetAddress('KT1P8RdJ5MfHMK5...');
if (fa12Set) {
  console.log(`FA1.2 set: ${fa12Set}`);
} else {
  console.log('Token not registered yet');
}
```

#### Get an FA2 Token's Set Address

```typescript
const fa2Set = await shieldBridge.getFA2SetAddress('KT1LkNWZg...', 0);
if (fa2Set) {
  console.log(`FA2 set: ${fa2Set}`);
} else {
  console.log('Token not registered yet');
}
```

#### Check if a Set is Registered

```typescript
const isRegistered = await shieldBridge.isRegisteredSet('KT1SetAddr...');
console.log(`Registered: ${isRegistered}`); // true or false
```

---

### V1/V2 Architecture Switching

The SDK supports both the legacy V1 (Map contract) and V2 (Factory contract) architectures. You can switch between them at runtime without re-initializing your sapling keys.

#### Switch to V1 for Fund Migration

```typescript
const sdk = new ShieldBridgeSDK({
  client: tezos,
  saplingMnemonic: 'word1 word2 ...',
  // Defaults to V2
});

await sdk.ready;

// Check V2 balance
const v2Balance = await sdk.getShieldedBalance({});

// Switch to V1 to access legacy funds
sdk.switchArchitecture('1');
const v1Balance = await sdk.getShieldedBalance({});

// Switch back to V2
sdk.switchArchitecture('2');
```

#### Check Current Architecture

```typescript
console.log(sdk.getArchitecture()); // '2' (default)
sdk.switchArchitecture('1');
console.log(sdk.getArchitecture()); // '1'
```

> **Note**: `switchArchitecture` throws if any operations are in flight. Wait for all pending operations before switching.

---

### Progress Callbacks

Monitor transaction progress in real-time with optional callbacks. Perfect for building UIs with loading states and progress bars!

#### Basic Progress Tracking

```typescript
const result = await shieldBridge.shield([{ amount: 5 }], {
  onGenerating: (params) => {
    console.log(`🔄 Generating ${params.length} transaction(s)...`);
  },
  onSigning: () => {
    console.log('✍️ Signing transaction...');
  },
  onSubmitting: (data) => {
    console.log(`📤 Submitted! Op hash: ${data.opHash}`);
  },
  onConfirmed: (data) => {
    console.log(`✅ Confirmed! Op hash: ${data.opHash}`);
  },
});
```

#### Progress Bar Integration

```typescript
let progress = 0;
const setProgress = (value: number) => {
  progress = value;
  updateProgressBar(progress); // Your UI update function
};

await shieldBridge.shield([{ amount: 5 }], {
  onGenerating: () => setProgress(25),
  onSigning: () => setProgress(50),
  onSubmitting: () => setProgress(75),
  onConfirmed: () => setProgress(100),
});
```

#### React/Vue Example

```typescript
const [status, setStatus] = useState('idle');
const [opHash, setOpHash] = useState('');

await shieldBridge.shield([{ amount: 5 }], {
  onGenerating: () => setStatus('Generating proof...'),
  onSigning: () => setStatus('Awaiting signature...'),
  onSubmitting: (data) => {
    setStatus('Broadcasting...');
    setOpHash(data.opHash);
  },
  onConfirmed: () => setStatus('Confirmed! ✅'),
});
```

#### Advanced: Step-by-Step Tracking

```typescript
const steps: string[] = [];

await shieldBridge.transfer(
  [
    {
      transfers: [
        { amount: 1, to: 'zet13iuD1...' },
        { amount: 2, to: 'zet13Kuz6...' },
      ],
    },
  ],
  {
    onGenerating: (params) => {
      // params contains the full array of transfer parameters
      steps.push(
        `Generating proof for ${params[0].transfers.length} recipients`,
      );
    },
    onSigning: () => {
      steps.push('Signing with wallet');
    },
    onSubmitting: (data) => {
      steps.push(`Transaction submitted: ${data.opHash}`);
      // Open block explorer
      window.open(`https://tzkt.io/${data.opHash}`, '_blank');
    },
    onConfirmed: (data) => {
      steps.push(`Confirmed! Op hash: ${data.opHash}`);
      // Trigger success notification
      showNotification('Transfer complete!');
    },
  },
);
```

#### Callbacks Available For

All transaction methods support callbacks:

- ✅ `shield(params, callbacks)`
- ✅ `unshield(params, callbacks)`
- ✅ `transfer(params, callbacks)`

> **Note**: All callbacks are **optional**. You can provide just the ones you need!

---

### View-Only Mode

View-only mode allows you to **monitor balances and transactions without the ability to spend**. Perfect for:

- 📊 **Auditing** - Monitor account activity
- 🔍 **Compliance** - Regulatory oversight
- 👀 **Read-only dashboards** - Display balances without risk
- 🔐 **Security** - Share viewing access without spending rights

#### Export a Viewing Key

First, export a viewing key from your spending key:

```typescript
// Initialize with spending key
const fullAccessSdk = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
});

// Export viewing key
const viewingKey = await fullAccessSdk.getViewingKey();
console.log(`Viewing key: ${viewingKey}`);
// Save this securely - it's a hex-encoded string
```

#### Initialize with Viewing Key

```typescript
// Initialize in view-only mode
const viewOnlySdk = new ShieldBridgeSDK({
  client: tezos,
  saplingViewingKey: 'abc123...', // The exported viewing key
});

console.log(viewOnlySdk.isViewOnlyMode); // true

// ✅ Can query balances
const balance = await viewOnlySdk.getShieldedBalance({});

// ✅ Can view transactions
const txs = await viewOnlySdk.getShieldedTransactions();

// ❌ Cannot perform transactions
await viewOnlySdk.shield([{ amount: 1 }]);
// Error: Cannot shield tokens in view-only mode
```

#### Use Cases

**Compliance Dashboard**

```typescript
const complianceSdk = new ShieldBridgeSDK({
  client: tezos,
  saplingViewingKey: customerViewingKey,
});

// Monitor customer activity
const balance = await complianceSdk.getShieldedBalance({});
const transactions = await complianceSdk.getShieldedTransactions();

// Generate compliance reports without spending ability
generateComplianceReport(balance, transactions);
```

**Portfolio Tracker**

```typescript
const portfolioSdk = new ShieldBridgeSDK({
  client: tezos,
  saplingViewingKey: portfolioViewingKey,
});

// Track all assets
const allBalances = await portfolioSdk.getAllShieldedBalances();
const totalValue = calculateTotalValue(allBalances);
displayPortfolio(totalValue);
```

---

### Operation Hash Tracking

All transaction methods return an operation hash for easy tracking on block explorers.

#### Getting the Operation Hash

```typescript
const result = await shieldBridge.shield([{ amount: 5 }]);

console.log(`Operation hash: ${result.opHash}`);
console.log(`Block hash: ${result.block?.hash}`);

// Open in TzKT explorer
const explorerUrl = `https://tzkt.io/${result.opHash}`;
window.open(explorerUrl, '_blank');
```

---

## 💡 Examples

### Complete Example: Shield, Transfer, and Unshield

```typescript
import { TezosToolkit } from '@tezos-x/octez.js';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import { ShieldBridgeSDK } from 'shield-bridge-sdk';

async function main() {
  // Initialize
  const tezos = new TezosToolkit('https://mainnet.tezos.ecadinfra.com');
  tezos.setSignerProvider(await InMemorySigner.fromSecretKey('edsk...'));

  const shieldBridge = new ShieldBridgeSDK({
    client: tezos,
    saplingSecret: 'sask...',
  });

  await shieldBridge.ready;

  // 1. Shield 10 tez
  console.log('Shielding 10 tez...');
  const shieldResult = await shieldBridge.shield([
    { amount: 10, memo: 'deposit' },
  ]);
  console.log(`✅ Shielded! Op: ${shieldResult.opHash}`);

  // 2. Check balance
  const balance = await shieldBridge.getShieldedBalance({});
  console.log(`💰 Balance: ${balance} tez`);

  // 3. Transfer 3 tez privately
  console.log('Transferring 3 tez...');
  const transferResult = await shieldBridge.transfer([
    {
      transfers: [
        {
          amount: 3,
          to: 'zet13iuD1bKNE5MAEXN4JfVEnSKHyoCAwUhGzXFANZxmeof2DJXGX4F23jEW5zgf7LpdK',
          memo: 'payment',
        },
      ],
    },
  ]);
  console.log(`✅ Transferred! Op: ${transferResult.opHash}`);

  // 4. Unshield 5 tez
  console.log('Unshielding 5 tez...');
  const unshieldResult = await shieldBridge.unshield([{ amount: 5 }]);
  console.log(`✅ Unshielded! Op: ${unshieldResult.opHash}`);

  // 5. Final balance
  const finalBalance = await shieldBridge.getShieldedBalance({});
  console.log(`💰 Final balance: ${finalBalance} tez`);
}

main().catch(console.error);
```

### Example: Payment Splitting

```typescript
async function splitPayment() {
  const shieldBridge = new ShieldBridgeSDK({
    client: tezos,
    saplingSecret: 'sask...',
  });

  await shieldBridge.ready;

  // Pay multiple recipients in one transaction
  await shieldBridge.transfer([
    {
      transfers: [
        { amount: 10, to: 'zet13Alice...', memo: 'alice' },
        { amount: 15, to: 'zet13Bob...', memo: 'bob' },
        { amount: 20, to: 'zet13Carol...', memo: 'carol' },
      ],
    },
  ]);

  console.log('✅ Payment split sent to 3 recipients!');
}
```

---

## ⚙️ Advanced Configuration

### Network Configuration (Shadownet)

```typescript
import { TezosToolkit } from '@tezos-x/octez.js';
import { InMemorySigner } from '@tezos-x/octez.js-signer';
import { ShieldBridgeSDK, shieldBridgeContract } from 'shield-bridge-sdk';

const tezos = new TezosToolkit('https://shadownet.tezos.ecadinfra.com');
tezos.setSignerProvider(await InMemorySigner.fromSecretKey('edsk...'));

const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
  tzktApi: 'shadownet',
  shieldBridgeContract: shieldBridgeContract.shadownet,
});
```

### Custom Configuration Options

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingMnemonic: 'word1 word2 word3 ...', // Use mnemonic instead of secret key

  // Network settings
  tzktApi: 'mainnet', // or 'shadownet'
  shieldBridgeContract: 'KT1...', // Custom contract (optional)
  contractArchitecture: '2', // '2' for Factory (default), '1' for legacy Map

  // Sapling params CDN
  saplingParamsUrl: 'https://cdn.shieldbridge.xyz/sapling-params/', // Custom CDN URL

  // Transaction settings
  minConfirmations: 2, // Wait for 2 confirmations (default: 1)

  // Display settings
  useBaseUnits: true, // Use mutez instead of tez (default: false)

  // Performance settings
  parallelThreads: true, // Parallel proof generation (default: true)

  // Incremental read caching
  saplingDiffCache: true, // Cache the sapling-diff delta — far less RPC per read (default: true)
  saplingBalanceCache: false, // Also cache decrypted notes (decrypt-only-new); opt-in (default: false)
  // saplingDiffStore: new MemoryDiffStore(), // Node/Lambda only — browser auto-uses IndexedDB
});
```

### Configuration Details

#### `minConfirmations`

Number of confirmations to wait for before considering a transaction complete.

```typescript
// Wait for 3 confirmations for extra security
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
  minConfirmations: 3,
});
```

#### `useBaseUnits`

Display amounts in base units (mutez) instead of tez.

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
  useBaseUnits: true, // Use 1000000 instead of 1 for 1 tez
});

// Shield 1 tez (specified as 1,000,000 mutez)
await shieldBridge.shield([{ amount: 1000000 }]);
```

#### `parallelThreads`

Enable parallel proof generation for faster batch operations.

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
  parallelThreads: true, // Generate proofs in parallel
});

// This will generate proofs for all 5 shields simultaneously
await shieldBridge.shield([
  { amount: 1 },
  { amount: 2 },
  { amount: 3 },
  { amount: 4 },
  { amount: 5 },
]);
```

> **Note**: Parallel mode is enabled by default and uses Web Workers in the browser and Node.js `worker_threads` in Node (both run the same pooled proof-generation workers). Set `parallelThreads: false` for sequential mode to reduce memory usage — in Node this also skips spawning a worker and runs the sapling core directly (useful for AWS Lambda).

#### `saplingDiffCache` (v1 — fetch cache, default **on**)

Every balance/transaction read needs the pool's sapling-diff. Re-fetching the whole diff each time is wasteful and gets worse as a pool grows. With the diff cache on, the SDK persists the **finalized prefix** (everything up to `head~2`, which is immutable under Tenderbake) and on the next read fetches only the small unconfirmed **tail** plus any new finalized entries. The decrypt/spend path is unchanged, so balances are byte-for-byte identical — this is purely an RPC-traffic optimization.

- **Browser:** persists to **IndexedDB** automatically (shared across same-origin workers). Nothing to configure.
- **Node/Lambda:** there is no IndexedDB, so supply a store via `saplingDiffStore` (e.g. `new MemoryDiffStore()`, or your own `SaplingDiffStore`). Only applied in direct-execution mode (`parallelThreads: false`).
- The cache holds only **public** diff data (commitments, ciphertexts, nullifiers) — nothing account-specific — so it is safe to share and keyed by `(rpc host, set address)`.

```typescript
// Node / Lambda: enable the diff cache with an in-memory store
import { ShieldBridgeSDK, MemoryDiffStore } from 'shield-bridge-sdk';

const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
  parallelThreads: false, // store injection requires direct mode
  saplingDiffStore: new MemoryDiffStore(),
});
```

#### `saplingBalanceCache` (v2 — decrypt cache, opt-**in**)

Layers on top of `saplingDiffCache`. In addition to the public diff, it caches this **account's decrypted notes** and on a warm scan decrypts only the commitments added since the last read — `O(new)` work instead of `O(pool)`. This is the optimization that makes loading many shielded balances (e.g. a whole portfolio) cheap.

Because it reimplements the balance sum, it is **guarded**: a runtime self-check recomputes the full stock balance every few scans and, on any divergence, invalidates the cache and returns the trusted stock value — so a cache bug can never surface a wrong balance. Reorg-safe by construction: only the finalized prefix is persisted; a note spent in the unconfirmed tail is excluded from the current scan but not written as spent, so a reorg self-heals on the next read.

**Encrypted at rest.** The decrypted notes are never written in the clear. Each cache entry is sealed with authenticated **XSalsa20-Poly1305** under a key derived from the viewing key itself (domain-separated keyed BLAKE2b). It uses pure JS/WASM (no `crypto.subtle`), so it works in non-secure contexts too (e.g. an HTTP/LAN origin). A locked account (viewing key sealed behind its password) can't be read off disk; a session-only account leaves only undecryptable ciphertext once its key is gone. This is an **at-rest** defense only — while the SDK is unlocked, keys and balances live in memory as usual.

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingMnemonic: 'word1 word2 ...',
  saplingBalanceCache: true, // opt in (saplingDiffCache must be on — it is, by default)
});
```

#### `clearShieldedBalanceCache()`

Evicts the **current account's** v2 decrypt-cache entries. The persistent cache lives in IndexedDB and **survives `destroy()`** (which only tears down workers) — that's intentional, so a lock/unlock keeps the cache warm. Call this explicitly when **forgetting** an account so no (encrypted) decrypted data is left behind. It must run while the SDK is still live, i.e. **before** `destroy()`.

```typescript
// On "forget account":
await shieldBridge.clearShieldedBalanceCache();
await shieldBridge.destroy();
```

#### `destroy()`

Cleans up all workers and clears in-memory state. Call this in SPAs when the component using the SDK unmounts. Note: this does **not** clear the persistent IndexedDB diff/balance cache — use `clearShieldedBalanceCache()` for that (see above).

```typescript
// In a React useEffect cleanup, for example:
useEffect(() => {
  return () => shieldBridge.destroy();
}, []);
```

---

## 📦 Exported Types

The SDK exports several TypeScript types for use in your application:

```typescript
import type {
  // SDK configuration
  ShieldBridgeSDKConfig,
  SaplingTokenInfo,
  ContractArchitecture, // '1' (legacy Map) | '2' (Factory)
  AmountInput, // number | string | BigNumber

  // Factory contract
  FactoryStorage, // On-chain factory contract storage shape
  ShieldedAssetInfo, // Asset info returned by getAllShieldedAssets()

  // Token metadata
  TokenMetadata, // TZIP-12/16 metadata (name, symbol, decimals, thumbnailUri)
  TzKTTokenBalance, // Token balance from TzKT API

  // Operations
  ShieldParams, // Parameters for shield()
  UnshieldParams, // Parameters for unshield()
  TransferParams, // Parameters for transfer()
  TransactionProgressCallbacks, // onGenerating/onSigning/onSubmitting/onConfirmed

  // Incremental diff cache (Node/Lambda store injection)
  SaplingDiffStore, // Store interface backing the diff cache
  CachedSaplingDiff, // Persisted finalized-prefix entry
  SaplingDiffResponse, // Shape of a single_sapling_get_diff response
} from 'shield-bridge-sdk';
```

The diff-cache stores and helper are exported as **values** (no heavy deps — they use only `fetch` + IndexedDB), so Node/Lambda consumers can inject one:

```typescript
import {
  MemoryDiffStore, // in-memory store (tests, short-lived Lambda)
  IndexedDbDiffStore, // explicit IndexedDB store (browser auto-uses this)
  createDefaultDiffStore, // picks IndexedDB in the browser, else null
  makeCachingReadProvider, // wraps an RPC read fn with the diff cache
} from 'shield-bridge-sdk';
```

---

## 🧪 Testing

The SDK uses [Vitest](https://vitest.dev/) for unit testing.

```bash
# Run tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

---

## ❓ FAQ

### How do I create a sapling secret key?

#### Option 1: Using Octez Client

```bash
./octez-client sapling gen key my-sapling-key --unencrypted
```

The secret key will be stored in `~/.tezos-client/sapling_keys`.

#### Option 2: Using a BIP39 Mnemonic

```typescript
import * as bip39 from 'bip39';

// Generate a 24-word mnemonic
const mnemonic = bip39.generateMnemonic(256);
console.log(mnemonic);

// Use it with the SDK
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingMnemonic: mnemonic,
});
```

### How do I add a new token to Shield Bridge?

To add a new token to Shield Bridge, use the `initTokenSaplingSet` method:

```typescript
// For FA2 tokens
const result = await shieldBridge.initTokenSaplingSet(
  'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2', // Token contract
  0, // Token ID
);

// For FA1.2 tokens
const result = await shieldBridge.initTokenSaplingSet(
  'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
);

console.log(`Token added! Op: ${result.opHash}`);
```

The contract automatically:

1. Verifies the token contract has the required entrypoints
2. Deploys a new Sapling Set contract for the token
3. Registers the Set contract in the factory's registry

### What's the difference between shield, unshield, and transfer?

| Operation    | Description                                       | Privacy Level                     |
| ------------ | ------------------------------------------------- | --------------------------------- |
| **Shield**   | Deposit transparent tokens → Shielded pool        | Sender visible, recipient private |
| **Unshield** | Withdraw from shielded pool → Transparent address | Sender private, recipient visible |
| **Transfer** | Send within shielded pool                         | Both sender & recipient private   |

### Can I use Shield Bridge on mobile?

Yes! Shield Bridge SDK works in browser and Node.js environments:

- ✅ Node.js applications (including AWS Lambda via `parallelThreads: false`)
- ✅ React/Vue/Angular web apps (desktop and mobile browsers / PWAs)
- ✅ Electron desktop apps
- ⚠️ React Native is **not** supported — it has neither a Web Worker nor Node `worker_threads` runtime for sapling proof generation

### Is it secure?

Yes! Shield Bridge uses:

- 🔐 **Sapling protocol** - Zero-knowledge proofs (same as Zcash)
- 🔒 **No key custody** - You control your keys
- 🌐 **Decentralized** - No central authority
- 🗄️ **Encrypted cache at rest** - the optional balance cache seals decrypted notes with XSalsa20-Poly1305 under a viewing-key-derived key, so no decrypted data is stored in the clear

### Can I cancel a transaction?

No. Once a transaction is submitted to the network, it cannot be cancelled. Always verify amounts and addresses before confirming.

---

## 📄 License

This project is licensed under the **MIT License**.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/AndrewKishino/shield-bridge-sdk/issues)
- **Discussions**: [GitHub Discussions](https://github.com/AndrewKishino/shield-bridge-sdk/discussions)

---

<div align="center">

**Made with ❤️ for the Tezos ecosystem**

[⭐ Star on GitHub](https://github.com/AndrewKishino/shield-bridge-sdk) • [📦 View on npm](https://www.npmjs.com/package/shield-bridge-sdk)

</div>
