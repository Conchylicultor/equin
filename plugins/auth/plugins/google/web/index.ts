import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { googleAuthConfig } from "../shared";
import { GoogleSetup } from "@plugins/auth/plugins/google/plugins/setup-wizard/web";
import { brand } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Google OAuth provider — adds the Google row to the Accounts pane and a credentials section to Settings.",
  contributions: [
    Auth.Provider({
      id: "google",
      name: "Google",
      description: "Gmail, Drive backups and other Google APIs.",
      icon: brand("google"),
      setup: { kind: "steps", component: GoogleSetup },
    }),
    ConfigV2.WebRegister({ descriptor: googleAuthConfig }),
  ],
} satisfies PluginDefinition;
