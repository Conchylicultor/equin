import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { conversationPrepromptRows } from "../../shared/schemas";

/** Inside a demo scope: No conversation was launched with a preprompt. */
export const conversationPrepromptsDemo = demoResource(
  "conversation-preprompts",
  (s) => [
    s.serveCollection(conversationPrepromptRows, {
      source: "external",
      changes: { fixed: { reason: "a demo's neutral answer" } },
      rows: () => [],
    }),
  ],
);
