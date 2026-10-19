import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { notionAuthConfig } from "../shared";
import { brand } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Notion OAuth provider (scaffold). Adds the Notion row to the Accounts pane, set up there with the generic OAuth client steps (console → redirect URI → client id + secret → connect), and registers the credentials config.",
  contributions: [
    Auth.Provider({
      id: "notion",
      name: "Notion",
      description: "Read and write Notion pages.",
      icon: brand("notion"),
      setup: {
        kind: "oauth-client",
        config: notionAuthConfig,
        consoleUrl: "https://www.notion.so/my-integrations",
        appNoun: "Notion integration",
        consoleNote: "Make it a public integration, so it signs in with OAuth.",
      },
    }),
    ConfigV2.WebRegister({ descriptor: notionAuthConfig }),
  ],
} satisfies PluginDefinition;
