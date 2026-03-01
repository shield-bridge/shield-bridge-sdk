import * as Comlink from 'comlink';
import type { SaplingWorker } from './worker.js';

/** Default maximum number of workers in the pool */
export const DEFAULT_POOL_SIZE = 5;

/** How long (ms) an idle worker stays alive before being reaped. Default: 5 minutes */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface PoolEntry {
  worker: Comlink.Remote<SaplingWorker>;
  busy: boolean;
  /** Whether the heavy sapling params (~50 MB) have been loaded in this worker */
  paramsLoaded: boolean;
  /** Timestamp (Date.now()) of the last time this entry was returned to the pool */
  lastUsed: number;
}

/**
 * A bounded, lazy-growing pool of Comlink-wrapped Sapling Web Workers.
 *
 * Design goals:
 * - **Lazy creation** – workers are only spawned when checkout() cannot find an
 *   idle worker and the pool has capacity.
 * - **Bounded concurrency** – at most `maxSize` workers exist simultaneously.
 * - **Worker reuse** – checked-in workers stay alive with their heavy sapling
 *   params already initialised, avoiding repeated ~50 MB fetches.
 * - **Back-pressure** – when all workers are busy the caller awaits a Promise
 *   that resolves as soon as any worker is returned.
 * - **Idle reaping** – a periodic sweep terminates workers that have been idle
 *   longer than `idleTimeoutMs`.
 */
export class SaplingWorkerPool {
  private pool: PoolEntry[] = [];

  private pendingCheckouts: Array<{
    resolve: (entry: PoolEntry) => void;
  }> = [];

  private idleTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the pool has been destroyed */
  private destroyed = false;

  /**
   * Number of workers currently being created (awaiting createWorkerFn).
   * This is used to prevent the pool from exceeding maxSize when multiple
   * concurrent checkout() calls race past the capacity check before the
   * first worker creation completes and pushes to the pool.
   */
  private creating = 0;

  constructor(
    /** Max workers that can exist at once */
    readonly maxSize: number,
    /** Factory that creates a new Comlink-wrapped worker */
    private readonly createWorkerFn: () => Promise<
      Comlink.Remote<SaplingWorker>
    >,
    /** How long (ms) an idle worker stays alive before being reaped */
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
  ) {
    // Start idle reaper
    this.startIdleReaper();
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Acquire an idle worker from the pool.
   *
   * - If an idle worker exists it is returned immediately.
   * - If the pool has room, a new worker is created and returned.
   * - Otherwise the caller is queued until a worker becomes available.
   *
   * The returned `PoolEntry` **must** be given back via `release()` when done.
   */
  async checkout(): Promise<PoolEntry> {
    if (this.destroyed) {
      throw new Error('SaplingWorkerPool has been destroyed');
    }

    // 1. Try to find an idle worker
    const idle = this.pool.find((w) => !w.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }

    // 2. Grow the pool if under capacity (including in-flight creations)
    if (this.pool.length + this.creating < this.maxSize) {
      this.creating += 1;
      let worker: Comlink.Remote<SaplingWorker>;
      try {
        worker = await this.createWorkerFn();
      } catch (err) {
        this.creating -= 1;
        throw err;
      }
      this.creating -= 1;
      const entry: PoolEntry = {
        worker,
        busy: true,
        paramsLoaded: false,
        lastUsed: Date.now(),
      };
      this.pool.push(entry);

      // Fire-and-forget param preload so it's ready before any proof generation
      worker
        .preloadSaplingParams()
        .then(() => {
          entry.paramsLoaded = true;
        })
        .catch((err: unknown) => {
          console.error(
            '[SaplingWorkerPool] Failed to preload sapling params:',
            err,
          );
        });

      return entry;
    }

    // 3. Pool is at capacity — wait for a worker to be returned
    return new Promise<PoolEntry>((resolve) => {
      this.pendingCheckouts.push({ resolve });
    });
  }

  /**
   * Return a worker to the pool. Any queued `checkout()` callers are served
   * immediately (FIFO).
   */
  release(entry: PoolEntry): void {
    // eslint-disable-next-line no-param-reassign
    entry.busy = false;
    // eslint-disable-next-line no-param-reassign
    entry.lastUsed = Date.now();

    // If someone is waiting, hand the worker over directly
    const waiter = this.pendingCheckouts.shift();
    if (waiter) {
      // eslint-disable-next-line no-param-reassign
      entry.busy = true;
      waiter.resolve(entry);
    }
  }

  /**
   * Destroy all workers and reject any pending checkouts.
   * After calling this the pool is unusable.
   */
  destroy(): void {
    this.destroyed = true;

    // Stop the idle reaper
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    // Terminate every worker
    this.pool.forEach((poolEntry) => {
      try {
        poolEntry.worker[Comlink.releaseProxy]();
      } catch {
        // Worker may already be terminated
      }
    });
    this.pool = [];
    this.pendingCheckouts = [];
  }

  // ─── Diagnostics ────────────────────────────────────────────────────

  /** Current number of workers (busy + idle) */
  get size(): number {
    return this.pool.length;
  }

  /** Number of workers currently checked out */
  get busyCount(): number {
    return this.pool.filter((w) => w.busy).length;
  }

  /** Number of idle workers ready for checkout */
  get idleCount(): number {
    return this.pool.filter((w) => !w.busy).length;
  }

  /** Number of callers waiting for a worker */
  get pendingCount(): number {
    return this.pendingCheckouts.length;
  }

  // ─── Internals ──────────────────────────────────────────────────────

  /**
   * Periodically terminate workers that have been idle too long to reclaim
   * memory (each worker holds ~60-80 MB of sapling WASM + params).
   */
  private startIdleReaper(): void {
    // Check every minute
    const REAPER_INTERVAL_MS = 60 * 1000;

    this.idleTimer = setInterval(() => {
      if (this.destroyed) return;

      const now = Date.now();
      // Never reap the last worker — keep at least one warm
      const minPoolSize = 1;

      // Identify idle workers eligible for reaping
      const toReap = this.pool.filter(
        (poolEntry) =>
          !poolEntry.busy && now - poolEntry.lastUsed > this.idleTimeoutMs,
      );

      // Don't reap below minimum pool size
      const maxReapable = this.pool.length - minPoolSize;
      const entriesToReap = toReap.slice(0, Math.max(0, maxReapable));

      entriesToReap.forEach((poolEntry) => {
        try {
          poolEntry.worker[Comlink.releaseProxy]();
        } catch {
          // Worker may already be terminated
        }
        const idx = this.pool.indexOf(poolEntry);
        if (idx !== -1) {
          this.pool.splice(idx, 1);
        }
      });

      if (entriesToReap.length > 0) {
        console.log(
          `[SaplingWorkerPool] Reaped ${entriesToReap.length} idle worker(s). Pool size: ${this.pool.length}`,
        );
      }
    }, REAPER_INTERVAL_MS);

    // Don't keep the process alive just for the reaper (Node.js)
    if (
      this.idleTimer &&
      typeof this.idleTimer === 'object' &&
      'unref' in this.idleTimer
    ) {
      (this.idleTimer as NodeJS.Timeout).unref();
    }
  }
}
