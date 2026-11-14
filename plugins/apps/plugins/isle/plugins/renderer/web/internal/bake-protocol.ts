// What the page and its bake workers say to each other (`bake-pool.ts` ⇄
// `bake.worker.ts`). Plain data and typed arrays only: everything crosses by
// structured clone, the big results by transfer.

import type { Box } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import type { IslandShapeData } from "@plugins/apps/plugins/isle/plugins/world/core";
import type { GroundKernel, PixelKernel, PreviewKernel } from "./ground-pixels";
import type { FurnitureData } from "./furniture";
import type { Mask } from "./hit-mask";

/** A kernel's pixels, as a worker hands them back (the kernel without its `rows`). */
export type Pixels<K extends PixelKernel> = Omit<K, "rows">;

/** A job a worker runs, by kind, and what it answers. */
export interface BakeJobs {
  /** The home island's river-and-lake carve grid. */
  carve: { job: { kind: "carve" }; out: Float32Array };
  /** An island's shape data, built from its seed. */
  shape: {
    job: { kind: "shape"; seed: number; island: number };
    out: IslandShapeData;
  };
  /** A ground tile's colour and water mask (the islands near it loaded first). */
  ground: {
    job: {
      kind: "ground";
      seed: number;
      tx: number;
      ty: number;
      near: readonly number[];
    };
    out: Pixels<GroundKernel>;
  };
  /** An island's coarse preview (its shape loaded first). */
  preview: {
    job: { kind: "preview"; seed: number; island: number };
    out: Pixels<PreviewKernel>;
  };
  /** An island's furniture (coast, boulders, trees, bushes, stumps; its shape loaded first). */
  furniture: {
    job: { kind: "furniture"; seed: number; island: number };
    out: FurnitureData;
  };
  /** A building's hit mask, read from its painted bitmap. */
  mask: { job: { kind: "mask"; bmp: ImageBitmap; bounds: Box }; out: Mask };
}

export type BakeKind = keyof BakeJobs;
export type BakeJob = BakeJobs[BakeKind]["job"];

/** Page → worker. */
export type ToWorker =
  /** Load: the carve grid, so the worker never builds it again. */
  | { readonly type: "carve"; readonly grid: Float32Array }
  /** Load: an island's shape, so the worker never builds it again. */
  | {
      readonly type: "shape";
      readonly seed: number;
      readonly island: number;
      readonly data: IslandShapeData;
    }
  | { readonly type: "job"; readonly id: number; readonly job: BakeJob };

/** Worker → page: a job's answer. */
export type FromWorker =
  | { readonly id: number; readonly ok: true; readonly out: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };
