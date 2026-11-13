import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { PanelSection } from "@plugins/companions/plugins/panel/web";
import {
  DraftPageProvider,
  NO_DRAFT_PAGE,
} from "@plugins/tasks/plugins/task-draft-form/web";
import { WishField } from "@plugins/wish/web";

/**
 * The tray's Wish section (MenuBar.Section 'wish'). The tray is about no page
 * — nothing to attach, nothing to pick.
 */
export function MenuBarWishSection() {
  return (
    <PanelSection label="Wish">
      <DraftPageProvider value={NO_DRAFT_PAGE}>
        <WishField filedFrom={asPluginId("companions.menu-bar.wish")} />
      </DraftPageProvider>
    </PanelSection>
  );
}
