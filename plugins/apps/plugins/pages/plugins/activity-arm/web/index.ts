import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { activityLinks } from "@plugins/activity/web";
import { pagesApp } from "@plugins/apps/plugins/pages/plugins/shell/core";
import { pageDetailRoute } from "@plugins/apps/plugins/pages/plugins/page-tree/core";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { pageActivityArm } from "../core";

export default {
  description:
    "The page arm's presence in every list of activity: its rows open the page in Pages. Its band's fields are its entity's exposures, presented by their own plugins.",
  contributions: [
    FieldPresentation.Register({ owner: pageActivityArm, fields: {} }),
    activityLinks(pageActivityArm, (row) =>
      pageDetailRoute.link(pagesApp, { pageId: row.id }),
    ),
  ],
} satisfies PluginDefinition;
