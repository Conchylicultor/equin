import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { stallMonitorConfig } from "../core";
import { stallMonitorKind } from "./internal/stall-kind";

export {
  recordEventLoopStall,
  recordLoopStallEvidence,
} from "./internal/record-stall";

export default {
  description:
    "Files a report when the health-monitor sampler detects a main-thread event-loop stall: captures the coherent-instant stall trace and files a deduped event-loop-stall report (fingerprinted on the dominant caller stack) so a frozen backend reaches the bell + Debug → Reports, linked to its trace.",
  contributions: [
    ConfigV2.Register({ descriptor: stallMonitorConfig }),
    stallMonitorKind,
  ],
} satisfies ServerPluginDefinition;
