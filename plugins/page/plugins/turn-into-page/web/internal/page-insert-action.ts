import { plainOf } from "@plugins/page/plugins/editor/core";
import type {
  InsertAction,
  InsertActionRun,
} from "@plugins/page/plugins/editor/web";
import { usePageNavigation } from "@plugins/page/plugins/page-reference/web";
import { textBlock } from "@plugins/page/plugins/text/core";
import { turnBlockIntoPage } from "./turn-block-into-page";
import { symbol } from "@plugins/ui/plugins/icons/core";

const descriptionIcon = symbol("description");

/**
 * The `/page` runner: turn the line into the page, then open it — as Notion
 * does, a page made from the slash menu is one you are about to write in. It
 * opens in place, through the navigation the editor's host declared (the block
 * keeps its id, which is the new page's id); a host that declared none leaves
 * the new row where it is.
 */
function usePageInsertRun(): InsertActionRun {
  const nav = usePageNavigation();
  return ({ blockId, text }) => {
    void turnBlockIntoPage(blockId, plainOf(text).trim()).then(() => {
      nav?.open(blockId).open();
    });
  };
}

/**
 * `/page`: a new sub-page made in place of the caret's line, listed right after
 * Text as in Notion, and opened once it exists. The line's other words become
 * its title (trimmed — the cut leaves the space that stood before the `/`), so
 * nothing the user typed disappears; an otherwise-empty line gives an untitled
 * page.
 *
 * An insert action rather than a menu `label` on the `page` block type: minting
 * a page means minting its `page_id` partition, which only the server's
 * turn-into-page op can do — a plain block-type conversion cannot.
 */
export const pageInsertAction: InsertAction = {
  id: "page",
  label: "Page",
  icon: descriptionIcon,
  aliases: ["sub-page", "subpage", "new page"],
  after: textBlock.type,
  useRun: usePageInsertRun,
};
