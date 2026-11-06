import { relative } from "node:path";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  openFacetedIndex,
  type FacetedIndex,
} from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import type { FromWorkerFrame, ToWorkerFrame } from "../shared/protocol";

// The faceted-tree worker: one thread holding this checkout's faceted index
// (`faceted`'s `openFacetedIndex`), started by the backend (`machine/`) through the
// daemon primitive. The facet extractors are build tooling, so they run here —
// on another thread, by path, never in the backend's own import closure
// (`boot:closure-digestable`).
//
// Frames are handled one at a time, in arrival order: the index is not
// re-entrant, and a refresh must see the one before it applied.

declare const self: Worker;

const post = (frame: FromWorkerFrame): void => self.postMessage(frame);

let root: string | null = null;
let index: FacetedIndex | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * The repo files this thread has loaded — its own code. A refresh naming one
 * means the index was built by code no longer on disk (`code-changed`).
 */
function* codeFiles(): Iterable<string> {
  if (root === null) return;
  for (const path of [import.meta.path, ...Object.keys(require.cache)]) {
    if (!path.startsWith(`${root}/`) || path.includes("/node_modules/"))
      continue;
    yield relative(root, path);
  }
}

async function handle(frame: ToWorkerFrame): Promise<void> {
  const t0 = performance.now();
  if (frame.type === "init") {
    try {
      root = frame.root;
      installRecordStore(openRecordStore());
      index = await openFacetedIndex(frame.root as AppPath, {
        readConcurrency: 8,
        codeFiles,
      });
      post({
        type: "ready",
        delta: index.full(),
        ms: performance.now() - t0,
      });
    } catch (err) {
      post({ type: "failed", id: null, message: describe(err) });
    }
    return;
  }
  if (index === null) {
    post({
      type: "failed",
      id: frame.id,
      message: "refresh before the index was built",
    });
    return;
  }
  try {
    const result = await index.refresh(frame.paths, frame.edited);
    post({
      type: "refreshed",
      id: frame.id,
      ms: performance.now() - t0,
      result,
    });
  } catch (err) {
    // A half-applied refresh leaves the index inconsistent: never use it again.
    index = null;
    post({ type: "failed", id: frame.id, message: describe(err) });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

self.onmessage = (event: MessageEvent<ToWorkerFrame>) => {
  const frame = event.data;
  queue = queue.then(() => handle(frame));
};
