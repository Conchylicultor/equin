import type {
  FacetedStart,
  PluginTreeDelta,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";

// The faceted-tree worker's frames (`bin/faceted-tree-worker.ts`, started by
// `machine/`). Plain data, structured-cloned.

export type ToWorkerFrame =
  /**
   * Build the index of the checkout at `root` (first frame, once), starting
   * from the checkpoint in `checkpointFile` when it can, and leaving its own
   * there.
   */
  | { type: "init"; root: string; checkpointFile: string }
  /** One watcher batch, repo-relative (see `LiveRepoSnapshot.refresh`). */
  | { type: "refresh"; id: number; paths: string[]; edited: string[] };

export type FromWorkerFrame =
  /** The index is built: the whole tree, and how its snapshot started. */
  | {
      type: "ready";
      delta: PluginTreeDelta;
      ms: number;
      start: FacetedStart;
    }
  | {
      type: "refreshed";
      id: number;
      ms: number;
      result:
        | { kind: "unchanged" }
        | { kind: "changed"; delta: PluginTreeDelta; nodes: number }
        | { kind: "code-changed"; path: string };
    }
  /**
   * The index was built but its checkpoint could not be left: the session
   * goes on; the next worker starts from an older one, or cold.
   */
  | { type: "checkpoint-failed"; message: string }
  /** The init (`id` null) or a refresh failed: the index is not usable. */
  | { type: "failed"; id: number | null; message: string };
