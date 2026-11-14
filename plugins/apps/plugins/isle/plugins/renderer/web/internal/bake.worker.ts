// A bake worker: colours ground tiles and island previews, builds island
// shapes and the home carve, lays out each island's furniture (coast,
// boulders, trees), and reads buildings' hit masks — off the page's
// thread, with the very same code the page runs (`ground-pixels.ts`,
// `hit-mask.ts`, the world core), so what it answers is bit-identical to what
// the page would have made. Started by `bake-pool.ts`
// (`new Worker(new URL("./bake.worker.ts", import.meta.url))`): vite bundles
// it whole, and its closure is part of the renderer artifact's address
// (web-artifacts' `own-files.ts`).

import {
  adoptHomeCarve,
  homeCarveGrid,
  WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import type { BakeJob, BakeJobs, FromWorker, ToWorker } from "./bake-protocol";
import { buildFurniture } from "./furniture";
import { groundKernel, previewKernel } from "./ground-pixels";
import { maskFromAlpha } from "./hit-mask";

interface WorkerScope {
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

const models = new Map<number, WorldModel>();
const modelOf = (seed: number) => {
  let M = models.get(seed);
  if (!M) models.set(seed, (M = new WorldModel(seed)));
  return M;
};

/** Pixels without their `rows`: plain data to post back. */
function data<T extends { rows: unknown }>(k: T): Omit<T, "rows"> {
  const { rows: _rows, ...rest } = k;
  return rest;
}

function run(job: BakeJob): { out: unknown; transfer: Transferable[] } {
  switch (job.kind) {
    case "carve": {
      const out: BakeJobs["carve"]["out"] = homeCarveGrid();
      return { out, transfer: [] }; // kept: this worker reads it too
    }
    case "shape": {
      const out: BakeJobs["shape"]["out"] = modelOf(job.seed)
        .island(job.island)
        .plan.data();
      return { out, transfer: [] }; // kept: this worker's own ground reads it
    }
    case "ground": {
      const M = modelOf(job.seed);
      const k = groundKernel(
        M,
        job.tx,
        job.ty,
        job.near.map((id) => M.island(id)),
      );
      k.rows(0, k.h);
      const out: BakeJobs["ground"]["out"] = data(k);
      return { out, transfer: [k.img.buffer, k.mask.buffer] };
    }
    case "preview": {
      const M = modelOf(job.seed);
      const k = previewKernel(M, M.island(job.island));
      k.rows(0, k.h);
      const out: BakeJobs["preview"]["out"] = data(k);
      return { out, transfer: [k.img.buffer] };
    }
    case "furniture": {
      const M = modelOf(job.seed);
      const out: BakeJobs["furniture"]["out"] = buildFurniture(
        M,
        M.island(job.island),
      );
      return { out, transfer: [] };
    }
    case "mask": {
      const { bmp, bounds } = job;
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) throw new Error("isle bake worker: no 2D context");
      g.drawImage(bmp, 0, 0);
      bmp.close();
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const out: BakeJobs["mask"]["out"] = maskFromAlpha(
        d,
        c.width,
        c.height,
        bounds,
      );
      return { out, transfer: [out.raw.buffer, out.bits.buffer] };
    }
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "carve") {
    adoptHomeCarve(m.grid);
    return;
  }
  if (m.type === "shape") {
    modelOf(m.seed).island(m.island).plan.restore(m.data);
    return;
  }
  let answer: { out: unknown; transfer: Transferable[] };
  try {
    answer = run(m.job);
  } catch (err) {
    // the job's own failure goes back to the page that asked, which throws it
    scope.postMessage({
      id: m.id,
      ok: false,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    return;
  }
  scope.postMessage({ id: m.id, ok: true, out: answer.out }, answer.transfer);
};
