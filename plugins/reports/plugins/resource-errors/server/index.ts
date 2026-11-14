import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  RESOURCE_ERROR_KIND,
  ResourceErrorPayloadSchema,
  resourceErrorFingerprint,
} from "../core";
import {
  renderResourceErrorTask,
  RESOURCE_ERROR_NOTIF_COOLDOWN_MS,
} from "./internal/resource-error-task";

export default {
  description:
    "Resource-error report kind: validates a failing live read's payload (key, params, the typed failure kind — loader-failed or not-found — and its message), fingerprints by key + kind (one failing resource = one row, whatever params or message), and renders an investigation task. Re-arms every 6h, since a standing failure re-fails on every retry.",
  contributions: [
    ReportKind({
      kind: RESOURCE_ERROR_KIND,
      schema: ResourceErrorPayloadSchema,
      fingerprint: resourceErrorFingerprint,
      meta: {
        tag: "[resource-error]",
        notif: "A live read failed",
        variant: "warning",
        category: "error",
        notifCooldownMs: RESOURCE_ERROR_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderResourceErrorTask,
    }),
  ],
} satisfies ServerPluginDefinition;
