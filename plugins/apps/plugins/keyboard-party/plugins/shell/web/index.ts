import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { keyboardPartyApp } from "../core";
import { KeyboardPartyLayout } from "./components/keyboard-party-layout";

export default {
  description:
    "App shell for Keyboard Party: registers the /keyboard-party app entry, whose one page is the party stage.",
  contributions: [
    Apps.App({
      app: keyboardPartyApp,
      icon: appIcon(symbol("celebration"), { color: "pink" }),
      component: KeyboardPartyLayout,
    }),
  ],
} satisfies PluginDefinition;
