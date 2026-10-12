import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Auth } from "@plugins/auth/web";
import { appleSetupPane } from "./panes";
import { AppleProviderRow } from "./components/apple-provider-row";
import { brand } from "@plugins/ui/plugins/icons/core";

export { appleSetupPane } from "./panes";

export default {
  description:
    "Apple code-signing UI: the Accounts 'Apple Developer' provider row plus the guided certificate + App Store Connect API key setup wizard pane.",
  contributions: [
    Pane.Register({ pane: appleSetupPane }),
    Auth.Provider({
      id: "apple-signing",
      name: "Apple Developer",
      icon: brand("apple"),
      rowComponent: AppleProviderRow,
    }),
  ],
  slots: { "apple-setup": appleSetupPane },
} satisfies PluginDefinition;
