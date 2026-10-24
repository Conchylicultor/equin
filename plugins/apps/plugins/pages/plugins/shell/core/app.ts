import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const pagesApp = defineApp({
  id: "pages",
  name: "Pages",
  basePath: "/pages",
  icon: symbol("description"),
});
