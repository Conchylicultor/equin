import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { BreadcrumbSlots } from "./slots";

export {
  Breadcrumb,
  type BreadcrumbProps,
  type BreadcrumbSegment,
} from "./internal/breadcrumb";

export { BreadcrumbSlots } from "./slots";
export type { BreadcrumbSeparatorContribution } from "./slots";

export default {
  description:
    "Generic breadcrumb: muted ancestor crumbs, a themed separator between them, and the current page as the one leaf that never gives up its letters — the oldest ancestors fold one by one into an overflow menu instead, keeping as many crumbs nearest the page as fit.",
  contributions: [],
  slots: BreadcrumbSlots,
} satisfies PluginDefinition;
