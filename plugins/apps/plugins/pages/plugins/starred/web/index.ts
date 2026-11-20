import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  PageDetail,
  PageTree,
} from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { starredPresentation } from "./internal/presentation";
import { StarRowAction } from "./components/star-row-action";
import { StarMenuItem } from "./components/star-menu-item";

export { StarredPageRowSchema } from "../shared/resources";
export type { StarredPageRow } from "../shared/resources";

export default {
  description:
    "Favorites/starred pages for the Pages app: presents the exposed `starred` field of the Pages sidebar DataView (Favorites is a filtered list view) plus a star toggle on page-tree rows and a favorites entry in the page's ⋯ menu.",
  contributions: [
    // The exposed `starred` boolean: its type's default presentation.
    starredPresentation,
    PageTree.RowActions({ id: "star", component: StarRowAction }),
    PageDetail.MenuItem({ id: "star", component: StarMenuItem }),
  ],
} satisfies PluginDefinition;
