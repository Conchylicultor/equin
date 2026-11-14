import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  PageUndoConflictPayloadSchema,
  pageUndoConflictFingerprint,
} from "../core";
import {
  renderPageUndoConflictTask,
  PAGE_UNDO_CONFLICT_NOTIF_COOLDOWN_MS,
} from "./internal/page-undo-conflict-task";

export default {
  description:
    "Page-undo-conflict report kind: validates the page editor's undo-conflict payloads (a text undo entry replayed over a block a second writer had changed since it was recorded, or a typing run dropped because a remote change landed inside it), fingerprints by reason alone (the block id, direction and the two lengths are per-occurrence noise), and renders an investigation task.",
  contributions: [
    ReportKind({
      kind: "page-undo-conflict",
      schema: PageUndoConflictPayloadSchema,
      fingerprint: pageUndoConflictFingerprint,
      meta: {
        tag: "[page-undo-conflict]",
        notif: "A text undo met a second writer",
        variant: "warning",
        category: "error",
        notifCooldownMs: PAGE_UNDO_CONFLICT_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderPageUndoConflictTask,
    }),
  ],
} satisfies ServerPluginDefinition;
