import { describe, it, expect } from 'vitest';
import {
  shieldBridgeContract,
  saplingFactoryContract,
  saplingMapContract,
  saplingStateMapContract,
  tzktApiMap,
} from '../src/constants';

describe('constants', () => {
  describe('shieldBridgeContract', () => {
    it('has mainnet and ghostnet addresses', () => {
      expect(shieldBridgeContract.mainnet).toMatch(/^KT1/);
      expect(shieldBridgeContract.ghostnet).toMatch(/^KT1/);
    });

    it('mainnet and ghostnet addresses are different', () => {
      expect(shieldBridgeContract.mainnet).not.toBe(
        shieldBridgeContract.ghostnet,
      );
    });
  });

  describe('deprecated aliases', () => {
    it('saplingFactoryContract points to shieldBridgeContract', () => {
      expect(saplingFactoryContract).toBe(shieldBridgeContract);
    });

    it('saplingStateMapContract points to saplingMapContract', () => {
      expect(saplingStateMapContract).toBe(saplingMapContract);
    });

    it('saplingMapContract has separate addresses from shieldBridgeContract', () => {
      expect(saplingMapContract.mainnet).not.toBe(shieldBridgeContract.mainnet);
    });
  });

  describe('tzktApiMap', () => {
    it('has mainnet and ghostnet URLs', () => {
      expect(tzktApiMap.mainnet).toContain('tzkt.io');
      expect(tzktApiMap.ghostnet).toContain('ghostnet');
    });

    it('URLs are HTTPS', () => {
      expect(tzktApiMap.mainnet).toMatch(/^https:\/\//);
      expect(tzktApiMap.ghostnet).toMatch(/^https:\/\//);
    });
  });
});
