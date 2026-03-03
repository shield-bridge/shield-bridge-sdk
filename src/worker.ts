/**
 * Comlink worker entry point.
 *
 * This module wraps the core sapling functions from `saplingCore.ts` with
 * Comlink so they can be called from the main thread across a Web Worker
 * (browser) or worker_threads (Node.js) boundary.
 *
 * All business logic lives in `saplingCore.ts`.  This file is:
 * - Compiled by tsc → dist/worker.js  (used by Node.js worker_threads)
 * - Bundled by webpack → dist/saplingWorker.js  (used by browser Web Workers)
 */
import * as Comlink from 'comlink';
import { saplingWorkerCore } from './saplingCore.js';
import type { SaplingWorkerCore } from './saplingCore.js';

// Re-export the core type as SaplingWorker for backward compatibility
export type SaplingWorker = SaplingWorkerCore;

// Re-export SaplingContractDetails for use in types.ts
export type { SaplingContractDetails } from './saplingCore.js';

// eslint-disable-next-line no-restricted-globals -- `self` is the standard web worker global
if (typeof self === 'undefined') {
  // Node.js environment
  // We use eval('require') to prevent Webpack from trying to bundle these Node.js-only modules
  // for the browser build.
  // eslint-disable-next-line no-eval
  const req = eval('require');
  const { parentPort } = req('worker_threads');
  const nodeEndpoint = req('comlink/dist/umd/node-adapter');
  Comlink.expose(saplingWorkerCore, nodeEndpoint(parentPort));
} else {
  // Browser environment
  Comlink.expose(saplingWorkerCore);
}
