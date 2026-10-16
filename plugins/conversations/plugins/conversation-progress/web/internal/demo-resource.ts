import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { conversationProgressRows } from "../../shared/schemas";

/** Inside a demo scope: No conversation reports progress steps. */
export const conversationProgressDemo = demoResource(
  "conversation-progress",
  (s) => [
    s.serveCollection(conversationProgressRows, {
      source: "external",
      changes: { fixed: { reason: "a demo's neutral answer" } },
      rows: () => [],
    }),
  ],
);
