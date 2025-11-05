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
  - [Progress Callbacks](#progress-callbacks)
  - [View-Only Mode](#view-only-mode)
  - [Operation Hash Tracking](#operation-hash-tracking)
- [💡 Examples](#-examples)
- [⚙️ Advanced Configuration](#️-advanced-configuration)
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
- ✅ **TypeScript support** - full type safety and IntelliSense
- ✅ **Flexible configuration** - customize gas limits, confirmations, and more

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
import { TezosToolkit } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
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
const balances = await shieldBridge.getAllShieldedBalances();
console.log('Shielded balances:', balances);
```

🎉 **That's it!** You're now using private transactions on Tezos.

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
const tezBalance = await shieldBridge.getShieldedBalance();

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

#### Get All Shielded Balances

```typescript
const balances = await shieldBridge.getAllShieldedBalances();

console.log(balances);
// [
//   { balance: 5.5, saplingId: 1 },
//   { balance: 100, saplingId: 2, contract: 'KT1...', tokenId: 0 },
//   { balance: 50, saplingId: 3, contract: 'KT1...' }
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
//   { saplingId: 1 }, // Tez
//   { saplingId: 2, contract: 'KT1...', tokenId: 0 }, // FA2
//   { saplingId: 3, contract: 'KT1...' } // FA1.2
// ]
```

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
    console.log(`✅ Confirmed in block ${data.block?.hash}`);
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
      steps.push(`Confirmed in block ${data.block?.hash}`);
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
const balance = await viewOnlySdk.getShieldedBalance();

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
const balance = await complianceSdk.getShieldedBalance();
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
import { TezosToolkit } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
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
  const balance = await shieldBridge.getShieldedBalance();
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
  const finalBalance = await shieldBridge.getShieldedBalance();
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

### Network Configuration (Ghostnet)

```typescript
import { ShieldBridgeSDK, saplingStateMapContract } from 'shield-bridge-sdk';

const tezos = new TezosToolkit('https://ghostnet.tezos.ecadinfra.com');
tezos.setSignerProvider(await InMemorySigner.fromSecretKey('edsk...'));

const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
  tzktApi: 'ghostnet',
  saplingStateMapContract: saplingStateMapContract.ghostnet,
});
```

### Custom Configuration Options

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingMnemonic: 'word1 word2 word3 ...', // Use mnemonic instead of secret key

  // Network settings
  tzktApi: 'mainnet', // or 'ghostnet'
  saplingStateMapContract: 'KT1...', // Custom state map contract

  // Transaction settings
  minConfirmations: 2, // Wait for 2 confirmations (default: 1)
  gasLimitBuffer: 3000, // Gas buffer (default: 2000)
  storageLimitBuffer: 600, // Storage buffer (default: 500)

  // Display settings
  useBaseUnits: true, // Use mutez instead of tez (default: false)

  // Performance settings
  parallelThreads: true, // Enable parallel proof generation (default: false)
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

#### `gasLimitBuffer` & `storageLimitBuffer`

Buffers added to estimated gas and storage limits to prevent operation failures.

```typescript
const shieldBridge = new ShieldBridgeSDK({
  client: tezos,
  saplingSecret: 'sask...',
  gasLimitBuffer: 5000, // Increase if operations fail due to gas
  storageLimitBuffer: 1000, // Increase if operations fail due to storage
});
```

> **Recommendation**: Use default values (2000 gas, 500 storage) unless you experience failures.

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

> **Note**: Parallel mode uses more memory but is faster for multiple operations.

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

To add a new token to the Shield Bridge state map, use the `initTokenSaplingPool` method:

```typescript
// For FA2 tokens
const result = await shieldBridge.initTokenSaplingPool(
  'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2', // Token contract
  0, // Token ID
);

// For FA1.2 tokens
const result = await shieldBridge.initTokenSaplingPool(
  'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
);

console.log(`Token added! Op: ${result.opHash}`);
```

The contract automatically:

1. Verifies the token contract has the required entrypoints
2. Creates a new Sapling pool for the token
3. Adds the mapping to the state map contract

### What's the difference between shield, unshield, and transfer?

| Operation    | Description                                       | Privacy Level                     |
| ------------ | ------------------------------------------------- | --------------------------------- |
| **Shield**   | Deposit transparent tokens → Shielded pool        | Sender visible, recipient private |
| **Unshield** | Withdraw from shielded pool → Transparent address | Sender private, recipient visible |
| **Transfer** | Send within shielded pool                         | Both sender & recipient private   |

### Can I use Shield Bridge on mobile?

Yes! Shield Bridge SDK works in any JavaScript/TypeScript environment:

- ✅ Node.js applications
- ✅ React/Vue/Angular web apps
- ✅ React Native mobile apps
- ✅ Electron desktop apps

### Is it secure?

Yes! Shield Bridge uses:

- 🔐 **Sapling protocol** - Zero-knowledge proofs (same as Zcash)
- 🔒 **No key custody** - You control your keys
- 🌐 **Decentralized** - No central authority

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
