// ---------------------------------------------------------------------------
// Contract addresses
// ---------------------------------------------------------------------------

/**
 * Shield Bridge contract addresses (V2 factory architecture).
 * Factory manages individual sapling set contracts for each asset.
 */
export const shieldBridgeContract = {
  mainnet: 'KT1WqGXxe5Anam6Hm6zQqGmaXdtZrzZRynnw',
  ghostnet: 'KT1XaGzt1byBue5BLbXpmKFtg7AEgZSKYNrf',
};

/**
 * @deprecated Use shieldBridgeContract (V2) instead
 * Factory contract addresses for V2 architecture
 */
export const saplingFactoryContract = shieldBridgeContract;

/**
 * @deprecated Use shieldBridgeContract (V2) for new integrations
 * Map contract addresses for V1 architecture (legacy)
 */
export const saplingMapContract = {
  mainnet: 'KT1RYEs6rfXgHqeb2XzfHKRii5NsNyKbS6WM',
  ghostnet: 'KT1WorWEWjfQqQ1X2BFQiCc4hE3DuDKQVH4U',
};

/**
 * @deprecated Use shieldBridgeContract (V2) or saplingMapContract (V1)
 * Kept for backward compatibility — points to V1 map contract
 */
export const saplingStateMapContract = saplingMapContract;

// ---------------------------------------------------------------------------
// TzKT API
// ---------------------------------------------------------------------------

export const tzktApiMap: Record<string, string> = {
  mainnet: 'https://api.tzkt.io',
  ghostnet: 'https://api.ghostnet.tzkt.io',
};
