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
  /**
   * The structure tree (every node, no facets), whole: once as soon as the
   * cold build has it — before the facets, so a structure reader never waits
   * for them — then within each refresh that moved it, ahead of that
   * refresh's `refreshed`.
   */
  | { type: "structure"; delta: PluginTreeDelta }
  /**
   * The index is built: its facets (the whole tree, or why they failed — the
   * structure is held either way) and how its snapshot started.
   */
  | {
      type: "ready";
      facets:
        | { kind: "built"; delta: PluginTreeDelta }
        | { kind: "failed"; message: string };
      ms: number;
      start: FacetedStart;
      /** Each build step's end, ms from the build's start (`FacetedIndex.steps`). */
      steps: Readonly<Record<string, number>>;
    }
  | {
      type: "refreshed";
      id: number;
      ms: number;
      result:
        | { kind: "unchanged" }
        | { kind: "changed"; delta: PluginTreeDelta; nodes: number }
        | { kind: "facets-failed"; message: string }
        | { kind: "facets-retry" }
        | { kind: "code-changed"; path: string };
    }
  /**
   * The index was built but its checkpoint could not be left: the session
   * goes on; the next worker starts from an older one, or cold.
   */
  | { type: "checkpoint-failed"; message: string }
  /**
   * The init (`id` null) or a refresh failed: the index is not usable — its
   * snapshot or structure failed (a facets failure is a `facets` outcome).
   */
  | { type: "failed"; id: number | null; message: string };
