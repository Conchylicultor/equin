import type { DemoScenario } from "@plugins/framework/plugins/browser-server/plugins/demo/core";

/** The conversation the demo opens at — its id is distinctive, so a leak to the real server is findable in its logs. */
export const DEMO_CONVERSATION_ID = "conv-demo-dark-mode";

/**
 * The Agent Manager at one conversation (`/agents/c/<id>`): the sidebar's
 * queue and done list, and an agent fixing a bug — nothing from the instance.
 * The story is served by real server code in this plugin's browser host
 * (`bin/browser-host.ts`), seeded from `./stories`. The app's owner declares
 * its scenario, so the demo plugins never name it.
 */
export const agentManagerDemo: DemoScenario = {
  id: "agent-manager",
  app: "agent-manager",
  route: `/c/${DEMO_CONVERSATION_ID}`,
  host: () => import("@browser-host/apps/plugins/agent-manager/plugins/demo"),
};
