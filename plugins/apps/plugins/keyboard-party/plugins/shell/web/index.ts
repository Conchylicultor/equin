import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { keyboardPartyApp } from "../core";
import { KeyboardPartyLayout } from "./components/keyboard-party-layout";

export default {
  description:
    "App shell for Keyboard Party: registers the /keyboard-party app entry, whose one page is the party stage.",
  contributions: [
    Apps.App({
      app: keyboardPartyApp,
      component: KeyboardPartyLayout,
    }),
  ],
} satisfies PluginDefinition;
