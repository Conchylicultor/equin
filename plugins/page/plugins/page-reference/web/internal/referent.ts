import { useLive } from "@plugins/network/plugins/live/web";
import type { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  pagesTree,
  trashedPages,
  pageData,
  type PageData,
} from "@plugins/page/plugins/editor/core";

/**
 * What a page id names, as a reference to it reads it — a union, so "not known
 * yet", "in the trash" and "no such page" are each their own answer:
 *
 *  - `pending` — neither read has answered yet;
 *  - `failed` — the live read failed with nothing seen before;
 *  - `live` — a page in the tree, with its data;
 *  - `trashed` — a page in the trash: still named (its data as it was
 *    trashed), opened read-only, restorable through `trashEntryId`;
 *  - `missing` — no page by that id, live or trashed (purged, or never one).
 */
export type PageReferent =
  | { state: "pending" }
  | {
      state: "failed";
      error: ResourceError;
      refetch: () => Promise<void>;
    }
  | { state: "live"; data: PageData }
  | {
      state: "trashed";
      data: PageData;
      trashEntryId: string;
      deletedAt: Date;
    }
  | { state: "missing" };

/**
 * Resolve a page id for a reference to it: the live tree first, and — only
 * once it answers not found — the trash (`trashedPages`), so a live page costs
 * one point read and a trashed one two. `null` reads nothing (`pending`).
 *
 * A failed live read that once had the page keeps resolving from it; a failed
 * trash read is `failed` too (never "missing" — that would be a claim).
 */
export function usePageReferent(pageId: string | null): PageReferent {
  const live = useLive(pagesTree, { id: pageId });
  const liveMissing = live.status === "ready" && !live.found;
  const trashed = useLive(trashedPages, {
    id: liveMissing ? pageId : null,
  });

  switch (live.status) {
    case "loading":
      return { state: "pending" };
    case "error":
      return live.stale === undefined
        ? { state: "failed", error: live.error, refetch: live.refetch }
        : { state: "live", data: pageData(live.stale) };
    case "ready":
      if (live.found) return { state: "live", data: pageData(live.row) };
  }

  switch (trashed.status) {
    case "loading":
      return { state: "pending" };
    case "error":
      return {
        state: "failed",
        error: trashed.error,
        refetch: trashed.refetch,
      };
    case "ready":
      return trashed.found
        ? {
            state: "trashed",
            data: pageData(trashed.row),
            trashEntryId: trashed.row.trashEntryId,
            deletedAt: trashed.row.deletedAt,
          }
        : { state: "missing" };
  }
}
