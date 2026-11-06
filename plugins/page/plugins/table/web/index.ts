import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Editor } from "@plugins/page/plugins/editor/web";
import { tableBlock } from "../core";
import { TableBlock } from "./components/table-block";
import { TableView } from "./components/table-view";

export default {
  description:
    "Table block type: a GFM pipe table edited in place like Notion's — click a cell and type, Tab between cells, grips to move / duplicate / delete rows and columns, insert points, add bars and column resizing (widths are display-only data, never in the markdown).",
  contributions: [
    Editor.Block({
      id: tableBlock.type,
      match: tableBlock.type,
      block: tableBlock,
      component: TableBlock,
      caret: "editor",
      view: TableView,
    }),
  ],
} satisfies PluginDefinition;
