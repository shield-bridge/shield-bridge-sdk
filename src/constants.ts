// ---------------------------------------------------------------------------
// Contract addresses
// ---------------------------------------------------------------------------

/**
 * Shield Bridge contract addresses (V2 factory architecture).
 * Factory manages individual sapling set contracts for each asset.
 */
export const shieldBridgeContract = {
  mainnet: 'KT1WqGXxe5Anam6Hm6zQqGmaXdtZrzZRynnw',
  shadownet: 'KT18zE1NnQpjDJnGmbYa5VTVV86YX5KLpHGv',
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
  shadownet: '', // Not deploying V1 Map contract on shadownet
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
  shadownet: 'https://api.shadownet.tzkt.io',
};
