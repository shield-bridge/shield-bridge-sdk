# Shield Bridge SDK

Shield Bridge SDK is a Typescript library that provides a simple interface to interact with the Shield Bridge smart contract on Tezos. It allows users to shield their tokens and tez to the deployed sapling shielded pools.

The Shield Bridge smart contract is a decentralized bridge that allows users to shield their FA1.2 tokens, FA2 tokens, and tez to the deployed sapling shielded pools. The shielded pools are used to mint shielded tokens that represent the underlying assets. The shielded tokens can be transferred to other users and can be redeemed for the underlying assets all while being obfuscated by the sapling protocol.

The advantage to using Shield Bridge is that all the underlying sapling shielded pools are deployed to a single smart contract which encourages network effects and reduces the need for users to deploy their own sapling shielded pools. This also means that multiple sapling transactions can be sent in a single operation for multiple tokens and tez which greatly reduces the overhead of interacting with multiple sapling shielded pool contracts.

## Table of Contents

- [Getting Started](#getting-started)
- [Installation](#installation)
- [Basic Usage](#basic-usage)
- [Advanced Usage](#advanced-usage)
- [FAQs](#faqs)

## Getting Started

This section will guide you through the basic steps to install and use the Shield Bridge SDK.

### Prerequisites

- Node.js >= v18 and npm installed.

### Installation

Install the package via npm:

```bash
npm install shield-bridge-sdk
```

### Basic Usage

- [Initialize the Shield Bridge SDK against mainnet with the following code](#initialize-the-shield-bridge-sdk-against-mainnet-with-the-following-code)
- [Shield tokens to the sapling shielded pools](#shield-tokens-to-the-sapling-shielded-pools)
- [Unshield tokens from the sapling shielded pools](#unshield-tokens-from-the-sapling-shielded-pools)
- [Transfer shielded tokens within the sapling shielded pools](#transfer-shielded-tokens-within-the-sapling-shielded-pools)
- [Get the balance of all shielded tokens](#get-the-balance-of-all-shielded-tokens)
- [Get the transaction history for a shielded token / tez](#get-the-transaction-history-for-a-shielded-token--tez)

#### Initialize the Shield Bridge SDK against mainnet with the following code

```typescript
import { TezosToolkit } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
import ShieldBridge from 'shield-bridge-sdk';

const tezos = new TezosToolkit('https://mainnet.api.tez.ie');
const signerProvider = await InMemorySigner.fromSecretKey('edsk...');
tezos.setSignerProvider(signerProvider);

const shieldBridge = new ShieldBridge({
  client: tezos,
  saplingSecret: 'sask...',
});
```

#### Shield tokens to the sapling shielded pools

```typescript
const op = await shieldBridge.shield([
  // Shield 10 tokens from FA1.2 contract KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS
  {
    amount: 10,
    contract: 'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
  },
  // Shield 10 tokens from FA2 contract KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2, tokenId 0
  {
    amount: 10,
    contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
    tokenId: 0,
  },
  // Shield 10 tez
  {
    amount: 10,
  },
]);
```

#### Unshield tokens from the sapling shielded pools

```typescript
const op = await shieldBridge.unshield([
  // Unshield 10 tokens from FA1.2 contract KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS
  {
    amount: 10,
    contract: 'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
  },
  // Unshield 10 tokens from FA2 contract KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2, tokenId 0
  {
    amount: 10,
    contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
    tokenId: 0,
  },
  // Unshield 10 tez
  {
    amount: 10,
  },
]);
```

#### Transfer shielded tokens within the sapling shielded pools

```typescript
const op = await shieldBridge.transfer([
  // Transfer 10 tokens from FA1.2 contract KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS
  {
    transfers: [
      {
        amount: 10,
        to: 'zet13iuD1bKNE5MAEXN4JfVEnSKHyoCAwUhGzXFANZxmeof2DJXGX4F23jEW5zgf7LpdK',
        memo: 'multitxn',
      },
    ],
    contract: 'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
  },
  // Transfer 10 tokens from FA2 contract KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2, tokenId 0
  {
    transfers: [
      {
        amount: 10,
        to: 'zet13iuD1bKNE5MAEXN4JfVEnSKHyoCAwUhGzXFANZxmeof2DJXGX4F23jEW5zgf7LpdK',
        memo: 'multitxn',
      },
    ],
    contract: 'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
    tokenId: 0,
  },
  // Transfer 10 tez
  {
    transfers: [
      {
        amount,
        to: 'zet13iuD1bKNE5MAEXN4JfVEnSKHyoCAwUhGzXFANZxmeof2DJXGX4F23jEW5zgf7LpdK',
        memo: 'multitxn',
      },
    ],
  },
]);
```

#### Get the balance of all shielded tokens

```typescript
const balances = await shieldBridge.getAllShieldedBalances();
```

#### Get the transaction history for a shielded token / tez

```typescript
// Get the transaction history for FA1.2 contract KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS
const transactions = await shieldBridge.getShieldedTransactions(
  'KT1P8RdJ5MfHMK5phKJ5JsfNfask5v2b2NQS',
);

// Get the transaction history for FA2 contract KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2, tokenId 0
const transactions = await shieldBridge.getShieldedTransactions(
  'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
  0,
);

// Get the transaction history for tez
const transactions = await shieldBridge.getShieldedTransactions();
```

### Advanced Usage

- [Initialize the Shield Bridge SDK against ghostnet](#initialize-the-shield-bridge-sdk-against-ghostnet)
- [Initialize the Shield Bridge SDK with an alternate configuration](#initialize-the-shield-bridge-sdk-with-an-alternate-configuration)
- [Modify the gas and storage limit buffers](#modify-the-gas-and-storage-limit-buffers)

#### Initialize the Shield Bridge SDK against ghostnet

```typescript
import { TezosToolkit } from '@taquito/taquito';
import { InMemorySigner } from '@taquito/signer';
import ShieldBridge, { saplingStateMapContract } from 'shield-bridge-sdk';

const tezos = new TezosToolkit('https://ghostnet.api.tez.ie');
const signerProvider = await InMemorySigner.fromSecretKey('edsk...');
tezos.setSignerProvider(signerProvider);

const shieldBridge = new ShieldBridge({
  client: tezos,
  saplingSecret: 'sask...',
  tzktApi: 'ghostnet',
  saplingStateMapContract: saplingStateMapContract.ghostnet,
});
```

#### Initialize the Shield Bridge SDK with an alternate configuration

```typescript
const shieldBridge = new ShieldBridge({
  client: tezos,
  saplingMnemonic: 'grunt inmate sword ...', // Use a mnemonic instead of a secret key
  saplingStateMapContract: 'KT1...', // Use a custom sapling state map contract
  tzktApi: 'ghostnet', // Use the ghostnet tzkt API for token metadata information
  gasLimitBuffer: 3000, // Increase the gas limit buffer
  storageLimitBuffer: 600, // Increase the storage limit buffer
  minConfirmations: 2, // Wait for 2 confirmations before returning from the operation
  useBaseUnits: true, // Use base units for token amounts. Using 1 mutez instead of 0.000001 tez
});
```

#### Modify the gas and storage limit buffers

The Shield Bridge SDK uses a gas and storage limit buffer to ensure that the operation has enough gas and storage to complete successfully. The default gas limit buffer is 2000 and the default storage limit buffer is 500. You can modify these values by passing them to the Shield Bridge constructor. In most cases, the default values should be sufficient. However, the operations may require a higher gas or storage limit due to other simultaneous calls to the Shield Bridge contract. You can also lower the gas and storage limit buffers, but you may experience more failed operations due to insufficient gas or storage limit errors.

```typescript
const shieldBridge = new ShieldBridge({
  client: tezos,
  saplingSecret: 'sask...',
  gasLimitBuffer: 1000,
  storageLimitBuffer: 100,
});
```

## FAQs

- [How do I create a saplingSecret?](#how-do-i-create-a-saplingsecret)
- [How do I add a new token and sapling pool to the Shield Bridge state map contract?](#how-do-i-add-a-new-token-and-sapling-pool-to-the-shield-bridge-state-map-contract)

### How do I create a saplingSecret?

A sapling secret key can be generated using the Octez client and issuing the command:

```bash
./octez-client sapling gen key test-sapling-key --unencrypted
```

This will generate a mnemonic and a secret key. The secret key can be found in `~/.tezos-client/sapling_keys`. Otherwise, you can use any bip39 mnemonic generator to generate a 24 word mnemonic.

```typescript
const mnemonic = bip39.generateMnemonic(256);
```

### How do I add a new token and sapling pool to the Shield Bridge state map contract?

The Shield Bridge SDK uses a state map contract to store the sapling pool addresses and token metadata. The state map contract is used to look up the sapling pool for a given token contract. If you want to add a new token and sapling pool to the state map contract, you can do so by calling the `init_token_sapling_pool` method in the Shield Bridge contract, or by calling the `initTokenSaplingPool` method in the Shield Bridge SDK.

```typescript
const op = await shieldBridge.initTokenSaplingPool(
  'KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2',
  0,
);
```

This will add the token contract `KT1LkNWZgVYh3zdaRkBb9aNgLEFCjVJwEKu2` with token id `0` to the state map contract. The contract will check if the token contract is a FA1.2 or FA2 contract by testing for the existence of the required entrypoints and will add the sapling pool address to the state map contract if the contract is valid.
