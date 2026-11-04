import { peekFocusedTabSet } from "@plugins/apps-core/plugins/tabs/web";
import { DESKTOP_PLACEMENT_ID } from "../../core";

/**
 * One-shot: whether the tab set the user is in (the page's, or an
 * `AppEmbed`'s) is in desktop mode — for shortcut `when` gates and event
 * handlers. Never from render: inside a tab set, read `useTabs().mode`.
 */
export function peekDesktopActive(): boolean {
  return peekFocusedTabSet()?.mode() === DESKTOP_PLACEMENT_ID;
}
