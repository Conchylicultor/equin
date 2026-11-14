import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import type { PhoneActionSheetProps } from "@plugins/apps-core/plugins/phone-actions/web";
import { WishField } from "./wish-field";

/**
 * The phone action button's Wish sheet (`PhoneActions.Action` "wish"): the
 * same Wish field the companions show — the task composer with its own ↑,
 * filing one task under Wishes about this page and confirming inline — so a
 * phone files a wish with the thumb, without the toolbar popover (too wide
 * for a phone).
 */
export function WishSheet(_props: PhoneActionSheetProps) {
  return <WishField filedFrom={asPluginId("wish")} />;
}
