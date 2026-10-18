import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { notionAuthConfig } from "../shared";
import { brand } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Notion OAuth provider (scaffold). Adds the Notion row to the Accounts pane and a credentials section to Settings.",
  contributions: [
    Auth.Provider({
      id: "notion",
      name: "Notion",
      description: "Read and write Notion pages.",
      icon: brand("notion"),
      helpUrl: "https://www.notion.so/my-integrations",
    }),
    ConfigV2.WebRegister({ descriptor: notionAuthConfig }),
  ],
} satisfies PluginDefinition;
