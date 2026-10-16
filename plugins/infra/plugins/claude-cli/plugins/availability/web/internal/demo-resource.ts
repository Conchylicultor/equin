import { demoResource } from "@plugins/framework/plugins/browser-server/plugins/demo/web";
import { claudeCodeStatus } from "../../core";

/** Inside a demo scope: The demo's Claude Code is installed and signed in — no account named. */
export const claudeCodeStatusDemo = demoResource("claude-code-status", (s) => [
  s.serveValue(claudeCodeStatus, {
    source: "external",
    changes: { fixed: { reason: "a demo's neutral answer" } },
    loader: () => ({
      kind: "ready" as const,
      version: "demo",
      authMethod: null,
      email: null,
    }),
  }),
]);
