import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { CaretFlightPayloadSchema, caretFlightFingerprint } from "../core";
import {
  renderCaretFlightTask,
  CARET_FLIGHT_NOTIF_COOLDOWN_MS,
} from "./internal/caret-flight-task";

export default {
  description:
    "Caret-flight report kind: validates the page editor's caret-authority abort payloads (a claimed caret landing that never happened, so the keystrokes it was holding were replayed back into the origin block — or lost), fingerprints by reason + recovered/lost (excluding the volatile block ids and buffer size, so one defect = one row), and renders an investigation task.",
  contributions: [
    ReportKind({
      kind: "caret-flight",
      schema: CaretFlightPayloadSchema,
      fingerprint: caretFlightFingerprint,
      meta: {
        tag: "[caret-flight]",
        notif: "Typing was interrupted mid-split",
        variant: "warning",
        category: "error",
        notifCooldownMs: CARET_FLIGHT_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderCaretFlightTask,
    }),
  ],
} satisfies ServerPluginDefinition;
