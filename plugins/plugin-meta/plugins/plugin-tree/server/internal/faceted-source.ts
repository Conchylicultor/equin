import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { PluginTreeData } from "@plugins/plugin-meta/plugins/plugin-tree/core";

/**
 * Where this host's faceted plugin tree comes from. Building it runs every
 * facet extractor — build tooling, loaded by a computed path — which never
 * runs in a serving backend (`boot:closure-digestable`), so the tree is held
 * elsewhere and read as data: the desktop's provider (`plugin-tree/faceted`'s
 * `machine/`) keeps it in a worker thread, built once and then refreshed by
 * the paths the backend's watcher saw.
 */
export interface FacetedTreeSourceImpl {
  /**
   * Start this checkout's faceted index: built cold, then kept up to date by
   * {@link FacetedTreeSession.refresh}. `onEnded` is called once if the
   * session ends on its own (its holder died or was stopped, its code
   * changed, a refresh failed): the caller opens a new one on next use.
   */
  open(onEnded: (reason: string) => void): FacetedTreeSession;
}

export interface FacetedTreeSession {
  /**
   * The tree as of the last refresh applied (the cold build, at first). A
   * failed or ended session rejects — never a partial tree.
   */
  tree(): Promise<PluginTreeData>;
  /**
   * Apply one watcher batch (repo-relative paths; `edited` = a watcher
   * `update`). Resolves true when the tree changed. Calls are applied in
   * order.
   */
  refresh(
    paths: readonly string[],
    edited: readonly string[],
  ): Promise<boolean>;
  /** End it (no `onEnded`). */
  close(): Promise<void>;
}

/**
 * What a session's pending calls reject with once it ended. `failed`: it
 * ended on an error (its worker died, a refresh or a frame failed) — loud.
 * Otherwise by design (closed, stopped on a restart-skip, its code changed):
 * the caller simply opens a new session.
 */
export class FacetedSessionEnded extends Error {
  constructor(
    readonly reason: string,
    readonly failed: boolean,
  ) {
    super(`[plugin-tree] the faceted-tree session ended: ${reason}`);
    this.name = "FacetedSessionEnded";
  }
}

export const FacetedTreeSource = defineHostService<FacetedTreeSourceImpl>(
  "plugin-tree.faceted-source",
);
