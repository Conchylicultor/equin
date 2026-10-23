import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  MainThreadStallPayloadSchema,
  mainThreadStallFingerprint,
} from "../core";
import {
  MAIN_THREAD_STALL_NOTIF_COOLDOWN_MS,
  renderMainThreadStallTask,
} from "./internal/main-thread-stall-task";

export default {
  description:
    "Main-thread-stall report kind: validates the stall payload (tab, app, route pattern, duration, how it ended, LoAF attribution, cohort), fingerprints by app + route pattern + top attributed function, and renders the investigation task.",
  contributions: [
    ReportKind({
      kind: "main-thread-stall",
      schema: MainThreadStallPayloadSchema,
      fingerprint: mainThreadStallFingerprint,
      meta: {
        tag: "[main-thread-stall]",
        notif: "Browser tab froze",
        variant: "error",
        notifCooldownMs: MAIN_THREAD_STALL_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderMainThreadStallTask,
    }),
  ],
} satisfies ServerPluginDefinition;
