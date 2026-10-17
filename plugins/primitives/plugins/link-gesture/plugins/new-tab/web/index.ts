import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  NewTabButton,
  NewTabGlyph,
  NewTabLink,
  NewTabMenuItem,
  newTabAnchorProps,
  type NewTabButtonProps,
  type NewTabHref,
} from "./components/new-tab";

export default {
  description:
    "The new-browser-tab control in every form — NewTabButton (icon or text), NewTabMenuItem, NewTabLink, newTabAnchorProps for a component rendered as a link, NewTabGlyph for a container that is one — owning the open-in-new glyph and the open-in-a-browser-tab behaviour together, so the arrow can never be paired with anything else. Enforced by new-tab/no-adhoc-new-tab.",
} satisfies PluginDefinition;
