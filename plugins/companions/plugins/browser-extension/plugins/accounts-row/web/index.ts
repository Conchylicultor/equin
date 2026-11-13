import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ExtensionSetup } from "./components/extension-setup";
import { useExtensionStatus } from "./internal/status";

export default {
  description:
    "The browser extension's row in Settings → Accounts (Auth.Integration, service equin): not built / not connected / connected · up to date / update pending — read live from the served shell's digest and the record the popup writes on each open — and, in its pane, the folder to load it unpacked from once.",
  contributions: [
    Auth.Integration({
      id: "browser-extension",
      name: "Browser extension",
      icon: symbol("extension"),
      service: "equin",
      description: "equin in Chrome's toolbar, on any tab.",
      setup: ExtensionSetup,
      useStatus: useExtensionStatus,
    }),
  ],
} satisfies PluginDefinition;
