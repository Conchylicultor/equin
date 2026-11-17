import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { BreadcrumbSlots } from "./slots";

export {
  Breadcrumb,
  type BreadcrumbProps,
  type BreadcrumbSegment,
} from "./internal/breadcrumb";

export {
  BreadcrumbPlaces,
  type BreadcrumbPlace,
  type BreadcrumbPlacesProps,
} from "./internal/places-menu";

export { BreadcrumbSlots } from "./slots";
export type { BreadcrumbSeparatorContribution } from "./slots";

export default {
  description:
    "Generic breadcrumb: muted ancestor crumbs, a themed separator between them, and the current page as the one leaf that never gives up its letters — the oldest ancestors fold one by one into an overflow menu instead, keeping as many crumbs nearest the page as fit. A crumb given its siblings lists them in a menu while the pointer rests on it (a click still goes to the crumb), each with what is inside it as a submenu. Every crumb states its siblings (null where it has none), and motion wipe animates a drill: the crumbs gone into wipe in, the ones come back out of wipe out.",
  contributions: [],
  slots: BreadcrumbSlots,
} satisfies PluginDefinition;
