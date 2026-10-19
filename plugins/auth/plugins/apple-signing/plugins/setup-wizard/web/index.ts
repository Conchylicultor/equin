import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { AppleSetup } from "./components/apple-setup";
import { useAppleSigningStatus } from "./components/use-apple-signing-status";
import { brand } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Apple code-signing UI: the Accounts 'Apple Developer' integration row and its guided certificate + App Store Connect API key setup, rendered inline in the row's Accounts pane.",
  contributions: [
    // Not an auth provider (no token in central — config fields and secrets),
    // so an integration: its pane renders the setup, which is also where it is
    // managed once configured.
    Auth.Integration({
      id: "apple-signing",
      name: "Apple Developer",
      icon: brand("apple"),
      service: "Apple",
      description: "Sign & notarize desktop releases with a Developer ID.",
      setup: AppleSetup,
      useStatus: useAppleSigningStatus,
    }),
  ],
} satisfies PluginDefinition;
