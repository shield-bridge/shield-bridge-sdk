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
    it('has mainnet and shadownet addresses', () => {
      expect(shieldBridgeContract.mainnet).toMatch(/^KT1/);
      expect(shieldBridgeContract.shadownet).toBeDefined();
    });

    it('mainnet and shadownet addresses are different', () => {
      expect(shieldBridgeContract.mainnet).not.toBe(
        shieldBridgeContract.shadownet,
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
    it('has mainnet and shadownet URLs', () => {
      expect(tzktApiMap.mainnet).toContain('tzkt.io');
      expect(tzktApiMap.shadownet).toContain('shadownet');
    });

    it('URLs are HTTPS', () => {
      expect(tzktApiMap.mainnet).toMatch(/^https:\/\//);
      expect(tzktApiMap.shadownet).toMatch(/^https:\/\//);
    });
  });
});
