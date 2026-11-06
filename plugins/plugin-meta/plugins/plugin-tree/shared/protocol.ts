import type { PluginTreeDelta } from "@plugins/plugin-meta/plugins/plugin-tree/core";

// The faceted-tree worker's frames (`bin/faceted-tree-worker.ts`, started by
// `machine/`). Plain data, structured-cloned.

export type ToWorkerFrame =
  /** Build the index of the checkout at `root` (first frame, once). */
  | { type: "init"; root: string }
  /** One watcher batch, repo-relative (see `LiveRepoSnapshot.refresh`). */
  | { type: "refresh"; id: number; paths: string[]; edited: string[] };

export type FromWorkerFrame =
  /** The cold index is built: the whole tree. */
  | { type: "ready"; delta: PluginTreeDelta; ms: number }
  | {
      type: "refreshed";
      id: number;
      ms: number;
      result:
        | { kind: "unchanged" }
        | { kind: "changed"; delta: PluginTreeDelta; nodes: number }
        | { kind: "code-changed"; path: string };
    }
  /** The init (`id` null) or a refresh failed: the index is not usable. */
  | { type: "failed"; id: number | null; message: string };
