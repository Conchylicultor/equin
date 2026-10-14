import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  PageTree,
  pageDetailPane,
} from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import { starredPresentation } from "./internal/presentation";
import { StarRowAction } from "./components/star-row-action";
import { StarHeaderAction } from "./components/star-header-action";

export { StarredPageRowSchema } from "../shared/resources";
export type { StarredPageRow } from "../shared/resources";

export default {
  description:
    "Favorites/starred pages for the Pages app: presents the exposed `starred` field of the Pages sidebar DataView (Favorites is a filtered list view) plus star toggles on page-tree rows and the page header.",
  contributions: [
    // The exposed `starred` boolean: its type's default presentation.
    starredPresentation,
    PageTree.RowActions({ id: "star", component: StarRowAction }),
    pageDetailPane.Actions({ id: "star", component: StarHeaderAction }),
  ],
} satisfies PluginDefinition;
