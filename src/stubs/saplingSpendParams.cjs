/**
 * Stub for saplingSpendParams - loads from CDN instead of bundling
 * Returns empty string so Buffer.from('', 'base64') doesn't crash.
 * The actual params are loaded by our initSaplingParams() which runs FIRST,
 * setting the @airgap/sapling-wasm internal flag to skip double-init.
 */
module.exports = {
  saplingSpendParams: '', // Empty base64 string - actual params loaded from CDN first
};
