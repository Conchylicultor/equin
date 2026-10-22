import type { FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { createBlock, PAGE_BLOCK_TYPE } from "@plugins/page/plugins/editor/core";
import { textBlock } from "@plugins/page/plugins/text/core";

/**
 * Create a new top-level page titled `title` and seed it with one empty text
 * block so it is immediately typeable, returning the new page id.
 *
 * Mirrors the pages app's `createPageWithSeed` rather than importing it: the same
 * editor↔text plugin-cycle constraint applies, so the helper that combines the
 * editor's `createBlock` with the `text` block lives in the consumer. `parentId:
 * null` makes it top-level; rank is omitted so the server appends it.
 */
export async function createLinkedPage(
  fetchEndpoint: FetchEndpoint,
  title: string,
): Promise<string> {
  const page = await fetchEndpoint(
    createBlock,
    {},
    { body: { parentId: null, type: PAGE_BLOCK_TYPE, data: { title, icon: null } } },
  );
  await fetchEndpoint(
    createBlock,
    {},
    {
      body: {
        parentId: page.id,
        type: textBlock.type,
        data: textBlock.schema.parse({ text: [] }),
      },
    },
  );
  return page.id;
}
