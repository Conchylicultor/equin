import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const mailApp = defineApp({
  id: "mail",
  name: "Mail",
  basePath: "/mail",
  icon: symbol("mail"),
  audience: "developer",
});
