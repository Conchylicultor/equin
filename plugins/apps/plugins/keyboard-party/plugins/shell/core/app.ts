import { defineApp } from "@plugins/primitives/plugins/pane/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export const keyboardPartyApp = defineApp({
  id: "keyboard-party",
  name: "Tap Tap Party",
  basePath: "/keyboard-party",
  icon: symbol("celebration"),
  iconColor: "pink",
});
