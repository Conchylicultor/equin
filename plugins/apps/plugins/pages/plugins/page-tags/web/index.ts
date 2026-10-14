import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  PageDetail,
  PageTree,
} from "@plugins/apps/plugins/pages/plugins/page-tree/web";
import {
  AddTagTool,
  UnderTitleTags,
  useHasNoTags,
  useHasTags,
} from "./components/header-tags";
import { TagDotsMarker } from "./components/sidebar-tags";

export default {
  description:
    "Page tags in the Pages app: the chips under a page's title with their picker (an Add tag tool in the header's hover row while the page has none), and colored dots marking each tagged page's sidebar row.",
  contributions: [
    PageDetail.UnderTitle({
      id: "tags",
      component: UnderTitleTags,
      useAvailable: useHasTags,
    }),
    PageDetail.HeaderTool({
      id: "add-tag",
      component: AddTagTool,
      useAvailable: useHasNoTags,
    }),
    PageTree.RowMarker({ id: "tags", component: TagDotsMarker }),
  ],
} satisfies PluginDefinition;
