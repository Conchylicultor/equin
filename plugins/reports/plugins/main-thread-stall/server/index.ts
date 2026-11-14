import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  MainThreadStallPayloadSchema,
  mainThreadStallFingerprint,
  SlowInteractionPayloadSchema,
  slowInteractionFingerprint,
} from "../core";
import {
  MAIN_THREAD_STALL_NOTIF_COOLDOWN_MS,
  renderMainThreadStallTask,
} from "./internal/main-thread-stall-task";
import {
  renderSlowInteractionTask,
  SLOW_INTERACTION_NOTIF_COOLDOWN_MS,
} from "./internal/slow-interaction-task";

export default {
  description:
    "Main-thread-stall report kind: validates the stall payload (tab, app, route pattern, duration, how it ended, LoAF attribution, cohort), fingerprints by the interaction's target when a click / key press started the freeze, else by app + route pattern + top attributed function, and renders the investigation task. Slow-interaction report kind: a click / key press whose next paint came late, fingerprinted by what was interacted with (element, contribution, pane, component — never the app or route), its time split into script / forced style-layout / style-layout / other with the function that forced it.",
  contributions: [
    ReportKind({
      kind: "main-thread-stall",
      schema: MainThreadStallPayloadSchema,
      fingerprint: mainThreadStallFingerprint,
      meta: {
        tag: "[main-thread-stall]",
        notif: "Browser tab froze",
        variant: "error",
        category: "slow-op",
        notifCooldownMs: MAIN_THREAD_STALL_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderMainThreadStallTask,
    }),
    ReportKind({
      kind: "slow-interaction",
      schema: SlowInteractionPayloadSchema,
      fingerprint: slowInteractionFingerprint,
      meta: {
        tag: "[slow-interaction]",
        notif: "Slow interaction",
        variant: "warning",
        category: "slow-op",
        notifCooldownMs: SLOW_INTERACTION_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderSlowInteractionTask,
    }),
  ],
} satisfies ServerPluginDefinition;
