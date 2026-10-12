import { useCallback } from "react";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import {
  blockLocations,
  pageData,
  pagesTree,
  PAGE_BLOCK_TYPE,
} from "@plugins/page/plugins/editor/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { blockDetailPane, pageDetailPane } from "../panes";

/**
 * What a bare block id opens, answered once for every surface that holds one (a
 * transcript chip, an Artifacts row, the block pane itself).
 *
 * - `page` — the id is a page: open the page.
 * - `block` — a content block inside `pageId`: open the block view.
 * - `missing` — no live block has this id (never existed, trashed, or a stale
 *   worktree fork that lacks it). An ordinary outcome, not a failure.
 * - `error` — the lookup itself failed; distinct from `missing` so a surface
 *   never renders "no such block" for a request that never answered.
 */
export type BlockTarget =
  | { kind: "pending" }
  | { kind: "missing" }
  | { kind: "error"; error: Error }
  | { kind: "page"; pageId: string }
  | { kind: "block"; pageId: string; blockId: string; type: string };

const PENDING: BlockTarget = { kind: "pending" };
const MISSING: BlockTarget = { kind: "missing" };

/**
 * Resolve a block id through `blockLocations` — one live row per id (its type
 * and nearest page ancestor), for a page and a content block alike, so a page
 * id and a content-block id cost the same one point read. Live: a trash, a
 * restore, a cross-page move or a turn-into-page re-answers in place, while a
 * content edit (the typing projection) moves no column the read holds and
 * reaches nothing.
 *
 * A page row answers with ITSELF (its own `pageId` names the page it sits
 * under); a content block with its nearest page ancestor; a page-less block at
 * the forest root is displayed by no page — the same "nothing to open" answer
 * as an unknown or trashed id.
 */
export function useBlockTarget(blockId: string): BlockTarget {
  const location = useLiveRow(blockLocations, blockId);
  switch (location.status) {
    case "loading":
      return PENDING;
    case "error":
      return { kind: "error", error: location.error };
    case "ready": {
      if (!location.found) return MISSING;
      const { row } = location;
      if (row.type === PAGE_BLOCK_TYPE) return { kind: "page", pageId: row.id };
      if (row.pageId === null) return MISSING;
      return { kind: "block", pageId: row.pageId, blockId, type: row.type };
    }
  }
}

/**
 * The link to a resolved target in the pane that shows it, as a column to the
 * RIGHT of the current surface (`push`) — so the transcript, or the page, the
 * id was found in stays beside it. A link, so ⌘/middle-click opens it in a new
 * browser tab.
 */
export function useBlockTargetLink(): (
  target: Extract<BlockTarget, { kind: "page" | "block" }>,
) => LinkTarget {
  const openPane = useOpenPane();
  return useCallback(
    (target) =>
      target.kind === "page"
        ? openPane.to(
            pageDetailPane,
            { pageId: target.pageId },
            { mode: "push" },
          )
        : openPane.to(
            blockDetailPane,
            { blockId: target.blockId },
            { mode: "push" },
          ),
    [openPane],
  );
}

/**
 * The human name of a block TYPE — its handle's `label` from the `Editor.Block`
 * registry ("TODO", "Toggle", "Heading 1"), derived from the registrations so a
 * new block plugin names itself here with no edit. A type with no label (or no
 * plugin loaded for it) reads as its raw type string rather than as nothing.
 */
export function useBlockTypeLabel(type: string): string {
  const contributions = Editor.Block.useContributions();
  return contributions.find((c) => c.block.type === type)?.block.label ?? type;
}

/** A page with no title of its own still has to be called something. */
const UNTITLED = "Untitled";

/**
 * A resolved target's one-line name: the page's title, or for a block
 * "<page title> › <block type label>" ("Plugin system › TODO") — the block is
 * named by where it lives and what it is, since a void card has no words of its
 * own. `undefined` while the target or the pages list is not known yet, or when
 * the target opens nothing (`missing` / `error`) — never a stand-in title.
 */
export function useBlockTargetTitle(target: BlockTarget): string | undefined {
  const label = useBlockTypeLabel(target.kind === "block" ? target.type : "");
  const opens = target.kind === "page" || target.kind === "block";
  const page = useLiveRow(pagesTree, opens ? target.pageId : null);
  if (!opens) return undefined;
  // The page row not known (loading), failed or absent: no title, never a
  // stand-in.
  if (page.status === "loading" || page.status === "error") return undefined;
  if (!page.found) return undefined;
  const title = pageData(page.row).title || UNTITLED;
  return target.kind === "page" ? title : `${title} › ${label}`;
}
