import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { hibernationConfig } from "@plugins/conversations/core";

import { implement } from "@plugins/infra/plugins/endpoints/core";
import { Demo } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { markViewed } from "../shared/endpoints";

export { useMarkConversationViewed } from "./internal/mark-viewed";

export default {
  description:
    "Records conversation selection so idle hibernation can reset the idle timer and transparently resume.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: hibernationConfig }),
    // A demo conversation is never hibernated: opening one resumes nothing.
    Demo.Route({
      route: [
        markViewed.route,
        implement(markViewed, () => ({ kind: "not-hibernated" as const })),
      ],
    }),
  ],
} satisfies PluginDefinition;
