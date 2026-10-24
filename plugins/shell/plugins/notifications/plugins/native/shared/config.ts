import { defineConfig } from "@plugins/config_v2/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";

export const nativeNotificationsConfig = defineConfig({
  fields: {
    enabled: boolField({
      default: false,
      label: "Native notifications",
      description:
        "Show each new notification as a native OS notification, through equin's menu-bar helper. Off by default; the switch is in the menu-bar panel, and only where the helper can notify.",
    }),
  },
});
