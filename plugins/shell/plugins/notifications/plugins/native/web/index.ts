import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { MenuBar } from "@plugins/menu-bar/web";
import { nativeNotificationsConfig } from "../shared/config";
import {
  NativeNotificationsForwarder,
  NativeNotificationsSwitch,
} from "./components/native-notifications";

export default {
  description:
    "Native OS notifications from the menu-bar panel: the Notifications switch (MenuBar.Section 'notifications', a config_v2 bool, off by default), shown only when the helper can notify, and a MenuBar.Mount that — while the switch is on — hands every notification that arrives (shell/notifications' useNotificationArrivals: live, never the ones already there) to the helper's notify.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: nativeNotificationsConfig }),
    MenuBar.Section({
      id: "notifications",
      label: "Notifications",
      component: NativeNotificationsSwitch,
    }),
    MenuBar.Mount({
      id: "native-notifications",
      component: NativeNotificationsForwarder,
    }),
  ],
} satisfies PluginDefinition;
