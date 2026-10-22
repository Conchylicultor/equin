import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { createBlock, PAGE_BLOCK_TYPE } from "@plugins/page/plugins/editor/core";
import { textBlock } from "@plugins/page/plugins/text/core";

/** A single content block to seed into a freshly created page, in order. */
export type PageSeedBlock = { type: string; data: unknown };

/**
 * Create a new page and seed it with content blocks so it is immediately
 * typeable. By default a page is seeded with one empty text block; callers
 * (e.g. the landing-page templates) may override the title and/or the seed
 * block list to start the page from a template.
 *
 * A brand-new page has no content blocks, and `BlockEditor` renders nothing
 * typeable in that state — the first block can only be created by splitting an
 * existing one. So every page must start with at least one block; when `seed`
 * is omitted we fall back to a single empty text block.
 *
 * This lives in the consumer (the pages app) rather than the editor plugin on
 * purpose: the editor plugin must not import the text block
 * (`@plugins/page/plugins/text`), since that would create an editor↔text plugin
 * cycle. The pages app may depend on both editor and text (acyclic), so it is
 * the right place to combine them. Centralizing here keeps every create path
 * (root "New Page", per-row "Add child", landing templates) seeding
 * consistently — and template seed payloads come pre-shaped from the caller's
 * block cores, which the server stores as-is.
 *
 * Seed blocks are parented to the page block (`parentId: page.id`):
 * `computePageId(null)` is null, so top-level page content must hang off the
 * page node, which the server then stamps with the page's `pageId`. They are
 * created sequentially (await each, in order) with no explicit rank, so the
 * server appends them in caller order.
 *
 * Both requests go through the caller's `fetchEndpoint` (its subtree's
 * transport, `useFetchEndpoint()`).
 *
 * Returns the new page id so the caller can open it.
 */
export async function createPageWithSeed(
  fetchEndpoint: FetchEndpoint,
  args: {
    parentId: string | null;
    /** Position the new page immediately after this existing sibling block. The
     *  server resolves it against the true sibling set (page rows AND the content
     *  rows sharing their `(parent_id, rank)` space); omit to append at the end. */
    afterId?: string;
    page?: { title?: string };
    seed?: PageSeedBlock[];
  },
): Promise<string> {
  const page = await fetchEndpoint(
    createBlock,
    {},
    {
      body: {
        parentId: args.parentId,
        type: PAGE_BLOCK_TYPE,
        data: { title: args.page?.title ?? "", icon: null },
        afterId: args.afterId,
      },
    },
  );

  const seed: PageSeedBlock[] =
    args.seed && args.seed.length > 0
      ? args.seed
      : [{ type: textBlock.type, data: textBlock.schema.parse({ text: [] }) }];

  for (const block of seed) {
    await fetchEndpoint(
      createBlock,
      {},
      {
        body: {
          parentId: page.id,
          type: block.type,
          data: block.data,
        },
      },
    );
  }

  return page.id;
}
