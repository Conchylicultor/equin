import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  applyPageBlockPatch,
  PAGE_BLOCK_TYPE,
  type Block,
} from "@plugins/page/plugins/editor/server";
import {
  resolveTagNames,
  writeResolvedPageTags,
} from "@plugins/page/plugins/tags/server";
import { setPageStarred } from "@plugins/apps/plugins/pages/plugins/starred/server";
import {
  fixturePages,
  type PageFixtureNode,
  type PageTreeFixture,
} from "../../core";

/**
 * Write `tree` into the workspace through the real write path, as a user's
 * edits would land: the whole forest in ONE `applyPageBlockPatch` at the
 * workspace root (the sanctioned forest write, which emits `blocksChanged` for
 * every page it creates), then each page's tags (`resolveTagNames`, creating a
 * missing name with the fixture's colour, then `writeResolvedPageTags`) and
 * star (`setPageStarred`).
 *
 * It derives nothing: the backlinks edges, the search documents and the
 * history snapshots are the `blocksChanged` consumers' (links, content-search,
 * history), which run as jobs on a host whose triggers are live. A caller that
 * needs them in place before it goes on settles the job queue
 * (`settleJobQueue`, the in-process queue).
 */
export async function writePageTree(tree: PageTreeFixture): Promise<void> {
  await applyPageBlockPatch(null, {
    creates: forestRows(tree, null, null, new Date()),
    updates: [],
    deleteIds: [],
  });
  for (const page of fixturePages(tree)) {
    if (page.tags !== undefined) {
      const resolved = await resolveTagNames(
        page.tags.map((t) => ({ name: t.name, create: { color: t.color } })),
      );
      if (!resolved.ok)
        throw new Error(
          `[pages fixtures] page ${page.id}'s tags did not resolve: ${JSON.stringify(resolved.unknown)}`,
        );
      await writeResolvedPageTags(page.id, resolved.tags);
    }
    if (page.starred) await setPageStarred(page.id, true);
  }
}

/** `nodes` as the editor's rows, parent first, under `parentId` in page `pageId`. */
function forestRows(
  nodes: readonly PageFixtureNode[],
  parentId: string | null,
  pageId: string | null,
  now: Date,
): Block[] {
  const ranks = Rank.nBetween(null, null, nodes.length);
  return nodes.flatMap((node, i): Block[] => {
    const row = {
      id: node.id,
      parentId,
      pageId,
      rank: ranks[i]!,
      expanded: true,
      createdAt: now,
      updatedAt: now,
    };
    if (node.type === PAGE_BLOCK_TYPE)
      return [
        { ...row, type: node.type, data: { title: node.title, icon: null } },
        ...forestRows(node.children, node.id, node.id, now),
      ];
    const text = [{ text: node.text }];
    return [
      {
        ...row,
        type: node.type,
        data:
          node.type === "to-do" ? { text, checked: node.checked } : { text },
      },
    ];
  });
}
