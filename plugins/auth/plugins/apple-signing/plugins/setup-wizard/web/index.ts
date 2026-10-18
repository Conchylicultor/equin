import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Auth } from "@plugins/auth/web";
import { appleSetupPane } from "./panes";
import { useAppleSigningStatus } from "./components/use-apple-signing-status";
import { brand } from "@plugins/ui/plugins/icons/core";

export { appleSetupPane } from "./panes";

export default {
  description:
    "Apple code-signing UI: the Accounts 'Apple Developer' integration row (opening the wizard) plus the guided certificate + App Store Connect API key setup wizard pane.",
  contributions: [
    Pane.Register({ pane: appleSetupPane }),
    // Not an auth provider (no token in central — config fields and secrets),
    // so an integration: its row opens the wizard, which is also where it is
    // managed once configured.
    Auth.Integration({
      id: "apple-signing",
      name: "Apple Developer",
      icon: brand("apple"),
      service: "Apple",
      description: "Sign & notarize desktop releases with a Developer ID.",
      pane: appleSetupPane,
      useStatus: useAppleSigningStatus,
    }),
  ],
  slots: { "apple-setup": appleSetupPane },
} satisfies PluginDefinition;
