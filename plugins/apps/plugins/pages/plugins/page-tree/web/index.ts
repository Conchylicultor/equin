import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Pages } from "@plugins/apps/plugins/pages/plugins/shell/web";
import { blockDetailPane, pageDetailPane, pagesTreePane } from "./panes";
import { PagesSidebar } from "./components/pages-sidebar";
import { NewPageItem } from "./components/new-page-item";
import {
  BacklinksUnderTitle,
  useHasBacklinks,
} from "./components/backlinks-section";
import {
  AddCoverTool,
  AddIconTool,
  ChangeIconTool,
  useHasIcon,
  useHasNoCover,
  useHasNoIcon,
} from "./components/header-tools";
import { DeletePageAction } from "./components/delete-page-action";
import { AddPageBelowAction } from "./components/add-page-below-action";
import { PageDetail, PageTree } from "./slots";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { PageDetail, PageTree, type PageHeaderPartProps } from "./slots";
export { blockDetailPane, pageDetailPane, pagesTreePane } from "./panes";
export {
  useBlockTarget,
  useBlockTargetTitle,
  useBlockTypeLabel,
  useBlockTargetLink,
  type BlockTarget,
} from "./internal/block-target";
export {
  createPageWithSeed,
  type PageSeedBlock,
} from "./internal/create-page-with-seed";

export default {
  description:
    "Sidebar page-tree plus the page-detail pane (header, editor, sections slot) and the block-detail pane (one block of a page, opened as a page of its own) for the Pages app, with useBlockTarget — the one resolver of a bare block id to the pane that shows it.",
  contributions: [
    Pane.Register({ pane: pageDetailPane }),
    Pane.Register({ pane: blockDetailPane }),
    Pane.Register({ pane: pagesTreePane }),
    Pages.Sidebar({
      id: "pages",
      title: "Pages",
      icon: symbol("description"),
      component: PagesSidebar,
    }),
    Pages.Sidebar({
      id: "new-page",
      title: "New page",
      icon: symbol("add"),
      component: NewPageItem,
    }),
    PageDetail.HeaderTool({
      id: "add-icon",
      component: AddIconTool,
      useAvailable: useHasNoIcon,
    }),
    PageDetail.HeaderTool({
      id: "change-icon",
      component: ChangeIconTool,
      useAvailable: useHasIcon,
    }),
    PageDetail.HeaderTool({
      id: "add-cover",
      component: AddCoverTool,
      useAvailable: useHasNoCover,
    }),
    PageDetail.UnderTitle({
      id: "backlinks",
      component: BacklinksUnderTitle,
      useAvailable: useHasBacklinks,
    }),
    PageTree.RowActions({ id: "delete", component: DeletePageAction }),
    PageTree.RowActions({ id: "add-below", component: AddPageBelowAction }),
  ],
  slots: {
    ...PageDetail,
    ...PageTree,
    "page-detail": pageDetailPane,
    "block-detail": blockDetailPane,
    "pages-tree": pagesTreePane,
  },
} satisfies PluginDefinition;
