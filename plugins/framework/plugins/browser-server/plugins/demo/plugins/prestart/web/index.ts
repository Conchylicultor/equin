import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  advanceHostGeneration,
  hostGeneration,
  hostWorkerName,
  trackHostGenerations,
} from "./internal/host-generation";
export type { HostGenerations } from "./internal/host-generation";
export { connectDemoHost, prestartDemoHost } from "./internal/prestart";
export type { DemoHostConnection } from "./internal/prestart";

export default {
  description:
    "Which SharedWorker a demo's tabs share — its name, the scenario and its Reset generation (kept page-wide, so a Reset moves every tab past the closing worker) — and connecting a tab to it (connectDemoHost: never to a worker that is retiring — its generation is skipped — and the head start's connection when there is one), started before the page boots where the page says so (prestartDemoHost, run by the demo page's head script), so the host boots alongside the page's own bundle. Kept apart from demo/scope so that head script loads only this, not the scope's UI.",
} satisfies PluginDefinition;
