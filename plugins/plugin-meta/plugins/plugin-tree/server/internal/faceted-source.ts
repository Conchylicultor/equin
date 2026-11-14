import { defineHostService } from "@plugins/framework/plugins/server-core/core";
import type { PluginTreeData } from "@plugins/plugin-meta/plugins/plugin-tree/core";

/**
 * Where this host's plugin trees come from — the faceted one and its
 * structure. Building the faceted tree runs every facet extractor — build
 * tooling, loaded by a computed path — which never runs in a serving backend
 * (`boot:closure-digestable`), so the tree is held elsewhere and read as data:
 * the desktop's provider (`plugin-tree/faceted`'s `machine/`) keeps it in a
 * worker thread, built once and then refreshed by the paths the backend's
 * watcher saw. The structure tree is the first thing that index builds (from
 * key-file records, off the backend's thread), so the session hands it out
 * too, ahead of the facets, instead of the backend building it a second time.
 */
export interface FacetedTreeSourceImpl {
  /**
   * Start this checkout's faceted index: built cold, then kept up to date by
   * {@link FacetedTreeSession.refresh}. `onEnded` is called once if the
   * session ends on its own (its holder died or was stopped, its code
   * changed, a refresh failed): the caller opens a new one on next use.
   */
  open(handlers: FacetedSessionHandlers): FacetedTreeSession;
}

export interface FacetedSessionHandlers {
  /**
   * Called once if the session ends on its own (see `open`), with why
   * (`ended.failed`: on an error — its worker died, its snapshot or
   * structure failed — not by design). `held`: which trees it had told a
   * reader about (a tree, or a facets failure).
   */
  onEnded(
    ended: FacetedSessionEnded,
    held: { structure: boolean; facets: boolean },
  ): void;
  /**
   * The structure tree moved after it was first handed out (a refresh moved
   * a plugin): {@link FacetedTreeSession.structure} now answers the new one.
   * Called before that refresh's own promise settles.
   */
  onStructureChanged(): void;
}

export interface FacetedTreeSession {
  /**
   * The tree as of the last refresh applied (the cold build, at first). A
   * failed or ended session rejects — never a partial tree — and so do the
   * facets while they are failed ({@link FacetsUnavailable}), until a refresh
   * builds them again; the session and its structure live on meanwhile.
   */
  tree(): Promise<PluginTreeData>;
  /**
   * The structure tree (every plugin, no facets) as of the last refresh that
   * reached it — handed out as soon as the cold build has it, before the
   * facets. A failed or ended session rejects.
   */
  structure(): Promise<PluginTreeData>;
  /**
   * Apply one watcher batch (repo-relative paths; `edited` = a watcher
   * `update`). Resolves true when the faceted tree changed — built again
   * after a failure, or failed after being built included (a structure
   * change is told through `onStructureChanged`, earlier). Calls are applied in
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

/**
 * What a read of the faceted tree rejects with while the session's facets
 * are failed: a facet module that did not load, or an extraction that threw.
 * The session lives on — its structure is unaffected — and its next refresh
 * builds the facets again.
 */
export class FacetsUnavailable extends Error {
  constructor(readonly detail: string) {
    super(`[plugin-tree] the faceted tree could not be built: ${detail}`);
    this.name = "FacetsUnavailable";
  }
}
