import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { googleAuthConfig } from "../shared";
import { googleSetupPane } from "@plugins/auth/plugins/google/plugins/setup-wizard/web";
import { brand } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Google OAuth provider — adds the Google row to the Accounts pane and a credentials section to Settings.",
  contributions: [
    Auth.Provider({
      id: "google",
      name: "Google",
      icon: brand("google"),
      helpUrl: "https://console.cloud.google.com/apis/credentials",
      credentialsPane: googleSetupPane,
    }),
    ConfigV2.WebRegister({ descriptor: googleAuthConfig }),
  ],
} satisfies PluginDefinition;
