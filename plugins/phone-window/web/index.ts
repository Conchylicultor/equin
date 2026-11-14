import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { OpenPhoneWindowRow } from "./components/open-phone-window-row";

export default {
  description:
    "Open phone window: a row in the action bar's view-options popover that opens this page (the same URL, the same browser session) in a pop-up window sized like a phone (the Phone device size), with no address bar — a real narrow window, so the app takes its phone layout. Developer-only; never shown inside the phone window itself.",
  contributions: [
    ActionBar.ViewOption({
      id: "open-phone-window",
      component: OpenPhoneWindowRow,
      audience: "developer",
    }),
  ],
} satisfies PluginDefinition;
