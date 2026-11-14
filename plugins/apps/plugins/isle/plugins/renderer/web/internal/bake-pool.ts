// The bake workers (`bake.worker.ts`): a small pool shared by everything on
// the page that bakes (the engine, the island-shape gate), started on the
// first lease and stopped when the last is released. A job goes to the least
// loaded worker, after what it reads that the worker does not have yet — the
// island shapes and the home carve the page already holds, sent once per
// worker, so no worker builds what another (or the page) already built.
//
// Where workers cannot run (no Worker or OffscreenCanvas) there is no pool and
// every bake runs on the page, as before. A worker that fails to start fails
// every job it holds as "failed" — the page bakes those itself — and the
// failure is thrown where the page reports uncaught errors, so a broken
// worker build is loud, not a quiet slowdown.

import type { Box } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import {
  homeCarveBuilt,
  homeCarveGrid,
  type Island,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import type {
  BakeJob,
  BakeJobs,
  BakeKind,
  FromWorker,
  ToWorker,
} from "./bake-protocol";

/** A job's answer, or "failed" when no worker could run it (bake it on the page). */
export type BakeAnswer<K extends BakeKind> = BakeJobs[K]["out"] | "failed";

interface Slot {
  readonly w: Worker;
  load: number;
  /** `<seed>:<island>` shapes it holds, and whether it holds the carve. */
  readonly shapes: Set<string>;
  carve: boolean;
}

interface Pending {
  resolve(out: unknown): void;
  reject(err: Error): void;
  readonly slot: Slot;
}

/** How many workers: a few, leaving the page and the rest of the machine a core or two. */
function poolSize(): number {
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
}

export class BakePool {
  private readonly slots: Slot[];
  private readonly jobs = new Map<number, Pending>();
  private nextId = 1;
  private failed = false;
  readonly size: number;

  constructor() {
    this.size = poolSize();
    this.slots = Array.from({ length: this.size }, () => {
      const w = new Worker(new URL("./bake.worker.ts", import.meta.url), {
        type: "module",
        name: "isle bake",
      });
      const slot: Slot = { w, load: 0, shapes: new Set(), carve: false };
      w.onmessage = (e: MessageEvent<FromWorker>) => this.answer(e.data);
      w.onerror = (e) => {
        e.preventDefault();
        this.fail(new Error(`isle bake worker failed: ${e.message}`));
      };
      w.onmessageerror = () =>
        this.fail(new Error("isle bake worker: a message could not be read"));
      return slot;
    });
  }

  /** Whether jobs still go to workers. */
  get working(): boolean {
    return !this.failed;
  }

  private answer(m: FromWorker): void {
    const j = this.jobs.get(m.id);
    if (!j) return;
    this.jobs.delete(m.id);
    j.slot.load--;
    if (m.ok) j.resolve(m.out);
    else j.reject(new Error(`isle bake worker: ${m.error}`));
  }

  /** Every job held goes back to the page; the failure itself is reported. */
  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    for (const [, j] of this.jobs) j.resolve("failed");
    this.jobs.clear();
    for (const s of this.slots) s.w.terminate();
    queueMicrotask(() => {
      throw err;
    });
  }

  dispose(): void {
    this.failed = true;
    for (const [, j] of this.jobs) j.resolve("failed");
    this.jobs.clear();
    for (const s of this.slots) s.w.terminate();
  }

  private post<K extends BakeKind>(
    job: BakeJobs[K]["job"] & BakeJob,
    needs: { M: WorldModel; islands: readonly Island[] } | null,
    transfer: Transferable[] = [],
  ): Promise<BakeAnswer<K>> {
    if (this.failed) return Promise.resolve("failed");
    const slot = this.slots.reduce((a, b) => (b.load < a.load ? b : a));
    if (needs) {
      if (
        needs.islands.some((I) => I.home) &&
        !slot.carve &&
        homeCarveBuilt()
      ) {
        slot.carve = true;
        this.send(slot, { type: "carve", grid: homeCarveGrid() });
      }
      for (const I of needs.islands) {
        const k = `${needs.M.seed}:${I.id}`;
        if (slot.shapes.has(k) || !I.plan.built()) continue;
        slot.shapes.add(k);
        this.send(slot, {
          type: "shape",
          seed: needs.M.seed,
          island: I.id,
          data: I.plan.data(),
        });
      }
    }
    const id = this.nextId++;
    slot.load++;
    return new Promise<BakeAnswer<K>>((resolve, reject) => {
      this.jobs.set(id, {
        resolve: (out) => resolve(out as BakeAnswer<K>),
        reject,
        slot,
      });
      this.send(slot, { type: "job", id, job }, transfer);
    });
  }

  private send(slot: Slot, m: ToWorker, transfer: Transferable[] = []): void {
    slot.w.postMessage(m, transfer);
  }

  carve(): Promise<BakeAnswer<"carve">> {
    return this.post<"carve">({ kind: "carve" }, null);
  }

  shape(M: WorldModel, I: Island): Promise<BakeAnswer<"shape">> {
    return this.post<"shape">(
      { kind: "shape", seed: M.seed, island: I.id },
      null,
    );
  }

  ground(
    M: WorldModel,
    tx: number,
    ty: number,
    near: readonly Island[],
  ): Promise<BakeAnswer<"ground">> {
    return this.post<"ground">(
      { kind: "ground", seed: M.seed, tx, ty, near: near.map((I) => I.id) },
      { M, islands: near },
    );
  }

  preview(M: WorldModel, I: Island): Promise<BakeAnswer<"preview">> {
    return this.post<"preview">(
      { kind: "preview", seed: M.seed, island: I.id },
      { M, islands: [I] },
    );
  }

  furniture(M: WorldModel, I: Island): Promise<BakeAnswer<"furniture">> {
    return this.post<"furniture">(
      { kind: "furniture", seed: M.seed, island: I.id },
      { M, islands: [I] },
    );
  }

  mask(bmp: ImageBitmap, bounds: Box): Promise<BakeAnswer<"mask">> {
    return this.post<"mask">({ kind: "mask", bmp, bounds }, null, [bmp]);
  }
}

let shared: { pool: BakePool; leases: number } | null = null;

/** A hold on the page's bake pool: `null` where workers cannot run. Release it once done. */
export interface PoolLease {
  readonly pool: BakePool;
  release(): void;
}

/** Whether this browser can run bake workers (module workers drawing on OffscreenCanvas). */
export function bakeWorkersAvailable(): boolean {
  return (
    typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined"
  );
}

export function leaseBakePool(): PoolLease | null {
  if (!bakeWorkersAvailable()) return null;
  if (!shared || !shared.pool.working)
    shared = { pool: new BakePool(), leases: 0 };
  const held = shared;
  held.leases++;
  let released = false;
  return {
    pool: held.pool,
    release() {
      if (released) return;
      released = true;
      held.leases--;
      if (held.leases === 0) {
        held.pool.dispose();
        if (shared === held) shared = null;
      }
    },
  };
}
