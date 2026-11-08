import { eq } from "drizzle-orm";
import {
  serveCollection,
  serveValue,
  type FollowBuilder,
} from "@plugins/network/plugins/live/server";
import { followsAtBind, type Follow } from "@plugins/network/plugins/live/core";
import { blockContentsServed } from "@plugins/page/plugins/editor/server";
import {
  PAGE_BLOCK_TYPE,
  pageData,
  textOf,
  type BlockContentsRow,
} from "@plugins/page/plugins/editor/core";
import {
  inlineTokenReferentFollows,
  inlineTokensAsLiveText,
} from "@plugins/primitives/plugins/text-editor/plugins/inline-chip/server";
import { pageBacklinkEdges, pageBacklinks, pageLinkTargets } from "../../core";
import type { BacklinkRow } from "../../core";
import { linkTargetRowsServeOptions } from "./link-target-rows";
import { deriveSnippet } from "./snippet";
import { _pageLinks, pageLinksEntity } from "./tables";

// The target's FIRST edges — one per linking page (`pageBacklinkEdges`, a
// scoped `all` by `targetPageId`): `page_links` with `first` as the base
// membership, so a second linking block's edge, or another target's, reaches
// no follower.
export const pageBacklinkEdgesServed = serveCollection(pageBacklinkEdges, {
  from: pageLinksEntity,
  where: eq(_pageLinks.first, true),
});

/**
 * How many ancestor levels a backlink's `path` follows above its source page —
 * each level one dependent follow (a follow's tuple is computed from the
 * rows of the follows before it, so a walk of unknown depth has no spelling;
 * a bounded chain does). Past it the path starts with {@link PATH_CUT}: the
 * list shows the path truncated from its lead anyway, nearest parent last.
 */
export const BACKLINK_PATH_LEVELS = 8;

/** The lead of a path cut at {@link BACKLINK_PATH_LEVELS}. */
const PATH_CUT = "…";

/** A page with no title of its own still has to be called something — the
 *  same fallback the page-link referent resolves a token to. */
const UNTITLED = "Untitled";

type Subject = { pageId: string };
type Level = `up:${number}`;
type BacklinkFollows = {
  readonly edges: Follow<{
    readonly sourcePageId: string;
    readonly sourceBlockId: string;
  }>;
  readonly target: Follow<BlockContentsRow>;
  readonly sources: Follow<BlockContentsRow>;
} & { readonly [L in Level]: Follow<BlockContentsRow> } & {
  readonly [R in `referent:${number}`]: Follow<{ readonly id: string }>;
};

const levelFollow = (i: number): Level => `up:${i}`;

/** `{ ids }` of a set, or `null` (the follow reads nothing) when it is empty. */
function idsOf(ids: Iterable<string | null>): { ids: string[] } | null {
  const set = new Set<string>();
  for (const id of ids) if (id !== null) set.add(id);
  return set.size === 0 ? null : { ids: [...set] };
}

/** The parent pages of the PAGE rows among `rows` — the next level up. */
function parentsOf(rows: readonly BlockContentsRow[]) {
  return idsOf(
    rows.filter((r) => r.type === PAGE_BLOCK_TYPE).map((r) => r.pageId),
  );
}

// What one target's backlinks read, every read by id or by its own scope:
//
// - `edges` — its first edges (one per linking page);
// - `target` — its own row (the title a snippet is split around);
// - `sources` — each linking page's row (title, icon) and its first linking
//   block (the snippet's text);
// - `up:1` … `up:N` — the ancestor pages above the linking pages, a level per
//   follow (the `path`);
// - `referent:<i>` — the rows the chips in the linking blocks' text name
//   (inline-chip's `inlineTokenReferentFollows`, one per chip family, none
//   when the text holds no such chip).
//
// Built at the bind (`followsAtBind`): the chip families contribute their
// referent reads as the plugin tiers load, after this value is declared.
function backlinkFollows(follow: FollowBuilder<Subject>): BacklinkFollows {
  const edges = follow(pageBacklinkEdgesServed, ({ pageId }) => ({
    where: { targetPageId: pageId },
  }));
  const target = follow(blockContentsServed, ({ pageId }) => ({
    ids: [pageId],
  }));
  const sources = follow.from({ edges }, blockContentsServed, (_s, rows) =>
    idsOf(rows.edges.flatMap((e) => [e.sourcePageId, e.sourceBlockId])),
  );
  const levels: Record<Level, Follow<BlockContentsRow>> = {};
  let below: Follow<BlockContentsRow> = sources;
  for (let i = 1; i <= BACKLINK_PATH_LEVELS; i++) {
    below = levels[levelFollow(i)] = follow.from(
      { below },
      blockContentsServed,
      (_s, rows) => parentsOf(rows.below),
    );
  }
  return {
    edges,
    target,
    sources,
    ...levels,
    ...inlineTokenReferentFollows(follow, { sources }, (rows) =>
      (rows.sources as readonly BlockContentsRow[])
        .filter((r) => r.type !== PAGE_BLOCK_TYPE)
        .map((r) => textOf(r)),
    ),
  };
}

// The source pages that link TO `pageId`, ordered by title (then id: push
// compares bytes, so a tie — every "Untitled" source — must come back in one
// order), each with its place in the page tree and the snippet of its first
// linking block in document order.
//
// Computed from what it follows alone — the loader makes no query of its own
// (the drift guard holds it to that) — so a write reaches a tuple only when it
// touches a row the tuple read: an edge into this page, the page itself, a
// linking page, its first linking block, an ancestor, or a referent a snippet
// names. Typing in any other block — the ~1s `data.text` projection — reaches
// none; typing in the linking block recomputes it (the snippet may move).
//
// A trashed source page keeps its edges (they are its content, restored with
// it): `blockContents` reads it not found meanwhile, which hides its row.
export const pageBacklinksServed = serveValue(pageBacklinks, {
  source: "db",
  follows: followsAtBind<Subject, BacklinkFollows>(backlinkFollows),
  loader: async (_params, { followed }) => {
    if (followed.edges.length === 0) return [];
    const byId = new Map<string, BlockContentsRow>();
    for (const row of followed.sources) byId.set(row.id, row);
    const ancestors = new Map<string, BlockContentsRow>();
    for (let i = 1; i <= BACKLINK_PATH_LEVELS; i++) {
      const level = followed[levelFollow(i)];
      if (level === undefined) {
        throw new Error(
          `page-backlinks: the follow "${levelFollow(i)}" was not built.`,
        );
      }
      for (const row of level) ancestors.set(row.id, row);
    }

    const [target] = followed.target;
    const targetTitle =
      target !== undefined && target.type === PAGE_BLOCK_TYPE
        ? pageData(target).title || UNTITLED
        : null;

    const rows: BacklinkRow[] = [];
    for (const edge of followed.edges) {
      const page = byId.get(edge.sourcePageId);
      if (page === undefined || page.type !== PAGE_BLOCK_TYPE) continue;
      const { title, icon } = pageData(page);
      const block = byId.get(edge.sourceBlockId);
      rows.push({
        id: page.id,
        title,
        icon,
        path: pathOf(page, ancestors),
        snippet:
          block === undefined || targetTitle === null
            ? null
            : deriveSnippet(
                await inlineTokensAsLiveText(textOf(block), followed),
                targetTitle,
              ),
      });
    }
    return rows.sort((a, b) =>
      a.title !== b.title
        ? a.title < b.title
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
  },
});

/**
 * A page's ancestor pages' titles, root first — up its `pageId` (nearest PAGE
 * ancestor) chain through the followed levels. A chain stops at a missing
 * (trashed) ancestor and guards against cycles; one still going past the
 * last followed level starts with {@link PATH_CUT}.
 */
function pathOf(
  page: BlockContentsRow,
  ancestors: ReadonlyMap<string, BlockContentsRow>,
): string[] {
  const path: string[] = [];
  const seen = new Set([page.id]);
  let cur = page.pageId;
  for (let level = 1; cur !== null && !seen.has(cur); level++) {
    if (level > BACKLINK_PATH_LEVELS) {
      path.unshift(PATH_CUT);
      break;
    }
    const row = ancestors.get(cur);
    if (row === undefined) break;
    seen.add(cur);
    path.unshift(pageData(row).title || UNTITLED);
    cur = row.pageId;
  }
  return path;
}

// A live page with the pages it links to, by id — a lookup-only `:rows` over
// `page_blocks` and the materialized `page_link_targets` join
// (`./link-target-rows.ts`): an edge write re-aggregates its source page's
// stored list, refilling that row alone for a reader holding it.
export const pageLinkTargetsServed = serveCollection(
  pageLinkTargets,
  linkTargetRowsServeOptions,
);
