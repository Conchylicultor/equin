import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  applyPageBlockPatch,
  PAGE_BLOCK_TYPE,
  type Block,
} from "@plugins/page/plugins/editor/server";
import {
  parseMarkdownToForest,
  withMintedIds,
  type IdentifiedBlock,
} from "@plugins/page/plugins/editor/core";
import { serverMarkdownContext } from "@plugins/page/plugins/markdown-apply/server";
import {
  resolveTagNames,
  writeResolvedPageTags,
} from "@plugins/page/plugins/tags/server";
import { setPageStarred } from "@plugins/apps/plugins/pages/plugins/starred/server";
import {
  fixturePages,
  type PageFixtureBlock,
  type PageFixture,
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

/**
 * One sibling of a written list: a fixture page or block, or a block parsed
 * from a markdown run (its id freshly minted).
 */
type Sibling =
  | { kind: "fixture"; node: PageFixture | PageFixtureBlock }
  | { kind: "parsed"; block: IdentifiedBlock };

const parsedSibling = (block: IdentifiedBlock): Sibling => ({
  kind: "parsed",
  block,
});

/**
 * `nodes` with every markdown run replaced by the blocks it parses to, in the
 * server's dialect (`serverMarkdownContext`, what `edit_page` reads). A run
 * that parses to a page is refused: a sub-page is a {@link PageFixture}, whose
 * id the caller chooses.
 */
function siblingsOf(nodes: readonly PageFixtureNode[]): Sibling[] {
  return nodes.flatMap((node): Sibling[] => {
    if (node.type !== "markdown") return [{ kind: "fixture", node }];
    const parsed = withMintedIds(
      parseMarkdownToForest(node.markdown, serverMarkdownContext()),
    );
    assertNoPage(parsed, node.markdown);
    return parsed.map(parsedSibling);
  });
}

function assertNoPage(blocks: readonly IdentifiedBlock[], markdown: string) {
  for (const block of blocks) {
    if (block.type === PAGE_BLOCK_TYPE)
      throw new Error(
        `[pages fixtures] a markdown run parsed to a page; write a sub-page as a PageFixture instead:\n${markdown}`,
      );
    assertNoPage(block.children, markdown);
  }
}

/** `nodes` as the editor's rows, parent first, under `parentId` in page `pageId`. */
function forestRows(
  nodes: readonly PageFixtureNode[],
  parentId: string | null,
  pageId: string | null,
  now: Date,
): Block[] {
  return siblingRows(siblingsOf(nodes), parentId, pageId, now);
}

function siblingRows(
  siblings: readonly Sibling[],
  parentId: string | null,
  pageId: string | null,
  now: Date,
): Block[] {
  const ranks = Rank.nBetween(null, null, siblings.length);
  return siblings.flatMap((sibling, i): Block[] => {
    const row = {
      id: sibling.kind === "fixture" ? sibling.node.id : sibling.block.id,
      parentId,
      pageId,
      rank: ranks[i]!,
      expanded: true,
      createdAt: now,
      updatedAt: now,
    };
    if (sibling.kind === "parsed") {
      // Its data is the parse's, validated at the write boundary like an edit's.
      const { block } = sibling;
      return [
        {
          ...row,
          type: block.type,
          data: block.data ?? {},
          expanded: block.expanded,
        },
        ...siblingRows(
          block.children.map(parsedSibling),
          block.id,
          pageId,
          now,
        ),
      ];
    }
    const { node } = sibling;
    if (node.type === PAGE_BLOCK_TYPE)
      return [
        {
          ...row,
          type: node.type,
          data: {
            title: node.title,
            icon: node.icon ?? null,
            ...(node.cover === undefined ? {} : { cover: node.cover }),
          },
        },
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
