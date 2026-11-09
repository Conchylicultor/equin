import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  advanceHostGeneration,
  hostGeneration,
  hostWorkerName,
  trackHostGenerations,
} from "./internal/host-generation";
export type { HostGenerations } from "./internal/host-generation";
export { prestartDemoHost } from "./internal/prestart";

export default {
  description:
    "Which SharedWorker a demo's tabs share — its name, the scenario and its Reset generation (kept page-wide, so a Reset moves every tab past the closing worker) — and starting it before the page boots (prestartDemoHost, run by the demo page's head script), so the host boots alongside the page's own bundle. Kept apart from demo/scope so that head script loads only this, not the scope's UI.",
} satisfies PluginDefinition;
