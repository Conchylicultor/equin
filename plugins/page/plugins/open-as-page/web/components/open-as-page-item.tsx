import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { PAGE_BLOCK_TYPE, type Block } from "@plugins/page/plugins/editor/core";
import { useEditorScope } from "@plugins/page/plugins/editor/web";
import { usePageNavigation } from "@plugins/page/plugins/page-reference/web";
import { runActivation } from "@plugins/primitives/plugins/link-gesture/core";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

/**
 * "Open as page" in the block-actions menu: the block and its nested lines,
 * opened as a page of their own beside the current one.
 *
 * Absent — not disabled — in three cases, each a place where the row would
 * promise something that is not there:
 *
 * - the host declared no `openBlock` (a single-surface embed has nowhere to put
 *   a second view);
 * - the block is a sub-page row, which already opens as the page it is;
 * - the block is the one this view is already zoomed into — opening it again
 *   would open the view you are looking at.
 */
export function OpenAsPageItem({
  block,
  close,
}: {
  block: Block;
  close: () => void;
}) {
  const openBlock = usePageNavigation()?.openBlock;
  const { rootId } = useEditorScope();
  if (!openBlock) return null;
  if (block.type === PAGE_BLOCK_TYPE || block.id === rootId) return null;
  return (
    // A row of the block-actions panel, beside its Copy block ID / Delete:
    // `keepFocus`, like them, so the editor keeps its focus until the action
    // has run.
    <ControlPanel.Row
      keepFocus
      icon={<Icon icon={navIcons.sidePane} />}
      onSelect={() => {
        // A menu pick has no link gesture to read (the row is a menu item, and
        // keyboard-selectable): it opens in place.
        runActivation(openBlock(block.id));
        close();
      }}
    >
      Open as page
    </ControlPanel.Row>
  );
}
