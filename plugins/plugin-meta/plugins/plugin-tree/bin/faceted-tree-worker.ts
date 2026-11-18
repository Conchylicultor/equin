import { relative } from "node:path";
import { installRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/core";
import { openRecordStore } from "@plugins/plugin-meta/plugins/plugin-records/cli";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { pluginStructureDelta } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  openFacetedIndex,
  type FacetedIndex,
} from "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
import {
  readToWorkerFrame,
  type FromWorkerFrame,
  type ToWorkerFrame,
} from "../shared/protocol";

// The plugin-tree worker: one thread holding this checkout's faceted index
// (`faceted`'s `openFacetedIndex`), started by the backend (`machine/`) through the
// daemon primitive — and with it the structure tree, which the index builds
// first and posts on its own (`structure` frames), so the backend builds
// neither. The facet extractors are build tooling, so they run here —
// on another thread, by path, never in the backend's own import closure
// (`boot:closure-digestable`).
//
// Frames are handled one at a time, in arrival order: the index is not
// re-entrant, and a refresh must see the one before it applied.
//
// Each worker lists the checkout with git when it starts (backed by git's
// fsmonitor where it is on: an agent checkout, not main). It used to start from the last
// worker's checkpoint instead, replaying the FSEvents journal since then —
// but that history is volume-wide: fseventsd delivers every event under the
// stream's root (on main, every agent's checkout below `.claude/worktrees/`;
// exclusion paths drop them only after the cost is paid), so a replay cost
// O(the machine's file activity since the last boot): 5–9 s on main's
// restarts under load, against 0.35–0.7 s for the listing, and a flooded
// replay reported "events dropped" and listed cold anyway (2026-11-15,
// plugin-tree CLAUDE.md).

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
      const built = await openFacetedIndex(frame.root as AppPath, {
        readConcurrency: 8,
        codeFiles,
        onStructure: (tree) =>
          post({ type: "structure", delta: pluginStructureDelta(tree) }),
      });
      index = built;
      post({
        type: "ready",
        facets: built.facets(),
        ms: performance.now() - t0,
        steps: built.steps,
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

self.onmessage = (event: MessageEvent<unknown>) => {
  const read = readToWorkerFrame(event.data);
  // A backend of other code (see `shared/protocol.ts`): it is told, and ends
  // the session; this thread serves nothing it cannot read.
  if (!read.ok) {
    index = null;
    post({ type: "failed", id: null, message: read.issue });
    return;
  }
  const frame = read.frame;
  queue = queue.then(() => handle(frame));
};
