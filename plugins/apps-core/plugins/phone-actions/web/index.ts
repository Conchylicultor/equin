import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { PhoneActionButton } from "./components/phone-action-button";
import { PhoneActions } from "./slots";

export { PhoneActions } from "./slots";
export type { PhoneActionContribution, PhoneActionSheetProps } from "./slots";

export default {
  description:
    "The phone action button: on a phone (below 768px), a floating button the thumb can reach — dragged anywhere, snapping to the nearer side edge, its place remembered and kept on screen as the window resizes. A tap fans its sub-actions (PhoneActions.Action: Apps, Wish) out as labelled bubbles toward the open side, its ⋯ turning into ×; each opens its sheet from the bottom, the button hidden while one is open. While the page scrolls it tucks into a thin edge tab, back about a second after scrolling stops (or on a tap). Desktop chrome is unchanged.",
  slots: PhoneActions,
  contributions: [
    Apps.Overlay({ id: "phone-action-button", component: PhoneActionButton }),
  ],
} satisfies PluginDefinition;
