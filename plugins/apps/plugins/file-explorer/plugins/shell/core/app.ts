import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const fileExplorerApp = defineApp({
  id: "file-explorer",
  name: "Files",
  basePath: "/files",
  icon: symbol("folder"),
});
