import { workspaceDemo } from "@plugins/apps/plugins/website/plugins/demos/plugins/workspace/core";

/**
 * The scenario /demo shows: what the page renders (`DemoLayout`) and what its
 * head script starts ahead (`server/`'s prestart), named once so the two
 * cannot start different hosts.
 */
export const demoScenario = workspaceDemo;
