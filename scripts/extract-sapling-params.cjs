#!/usr/bin/env node

/**
 * Extract raw binary sapling parameters from the base64-encoded JS modules
 * shipped with @tezos-x/octez.js-sapling and write them as standalone .params
 * files into dist/.
 *
 * These files are loaded lazily by the web worker at proof-generation time
 * so they can be served from the consumer's own origin — no external CDN needed.
 */

const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '..', 'dist');

// Require the base64-encoded param modules
const {
  saplingSpendParams,
} = require('@tezos-x/octez.js-sapling/saplingSpendParams');
const {
  saplingOutputParams,
} = require('@tezos-x/octez.js-sapling/saplingOutputParams');

const spendBuf = Buffer.from(saplingSpendParams, 'base64');
const outputBuf = Buffer.from(saplingOutputParams, 'base64');

fs.mkdirSync(distDir, { recursive: true });

fs.writeFileSync(path.join(distDir, 'sapling-spend.params'), spendBuf);
fs.writeFileSync(path.join(distDir, 'sapling-output.params'), outputBuf);

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`Extracted sapling-spend.params  (${mb(spendBuf.length)} MB)`);
console.log(`Extracted sapling-output.params (${mb(outputBuf.length)} MB)`);
