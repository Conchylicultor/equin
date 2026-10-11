import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export type {
  BootPhase,
  BootSpan,
  NavTiming,
  LongTask,
  AssetTiming,
  BootTrace,
} from "../core";
export {
  startBootSpan,
  markBootInstant,
  markBootInstantAtNextCommit,
  traceBootPluginLoad,
  recordBootSpan,
  getBootTrace,
  subscribeBootTrace,
  useBootTrace,
  refreshBootTrace,
  bootWindowEnd,
} from "./internal/store";

export default {
  description:
    "Module-level boot-span store imported eagerly by the framework boot path. Captures one-clock boot spans (startBootSpan/markBootInstant/recordBootSpan) and folds in Navigation/Paint Timing plus the first React commit; getBootTrace() assembles the trace. Every span / instant is mirrored as a User Timing measure / mark named boot:<id>, so an outside reader (a Playwright script) reads it with performance.getEntriesByType.",
  contributions: [],
} satisfies PluginDefinition;
