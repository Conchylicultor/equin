import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { CrashPayloadSchema, crashFingerprint } from "../core";
import { renderCrashTask } from "./internal/render-crash-task";

export default {
  description:
    "Crash report kind: validates crash payloads, fingerprints by error + stack, and renders per-crash tasks.",
  contributions: [
    ReportKind({
      kind: "crash",
      schema: CrashPayloadSchema,
      fingerprint: crashFingerprint,
      meta: {
        tag: "[crash]",
        notif: "Crash recorded",
        variant: "error",
        category: "error",
      },
      renderTask: renderCrashTask,
    }),
  ],
} satisfies ServerPluginDefinition;
