/**
 * Node worker_thread parity test.
 *
 * Proves that the Node worker bundle (dist/saplingWorker.cjs) actually boots in
 * a Node worker_thread and completes a Comlink round-trip — i.e. that Node
 * "parallel" mode works like the browser, not crashing on the worker's
 * `eval('require')` under package.json "type":"module".
 *
 * Requires a prior `npm run build` (the .cjs bundle must exist). When the bundle
 * is absent the suite is skipped rather than failed, so `npm test` without a
 * build stays green; the release flow builds before testing, which exercises it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as Comlink from 'comlink';

const require = createRequire(import.meta.url);
const distWorker = path.resolve(__dirname, '../dist/saplingWorker.cjs');
const built = existsSync(distWorker);

describe.skipIf(!built)(
  'Node worker_thread parity — dist/saplingWorker.cjs',
  () => {
    it('boots the .cjs worker in a Node worker_thread and completes a Comlink round-trip', async () => {
      // node-adapter is a CJS/UMD module; require it the way index.ts does.
      const nodeEndpoint = require('comlink/dist/umd/node-adapter');
      const worker = new Worker(distWorker);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const proxy = Comlink.wrap<any>(nodeEndpoint(worker));
        // Trivial method — no network, no params load. Its success proves the
        // worker module loaded (no "require is not defined in ES module scope"
        // crash) and that Comlink expose/wrap works across the thread boundary.
        const loaded = await proxy.areSaplingParamsLoaded();
        expect(typeof loaded).toBe('boolean');
        expect(loaded).toBe(false);
      } finally {
        await worker.terminate();
      }
    }, 60_000);
  },
);
