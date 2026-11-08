import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  PopoverAnchorLostPayloadSchema,
  popoverAnchorLostFingerprint,
} from "../core";
import {
  renderPopoverAnchorLostTask,
  POPOVER_ANCHOR_LOST_NOTIF_COOLDOWN_MS,
} from "./internal/popover-anchor-lost-task";

export default {
  description:
    "Popover-anchor-lost report kind: validates ui-kit's lost-anchor fault payloads (an open popover whose anchor left the document or went display: none, which used to throw the panel into the screen's top-left corner), fingerprints by cause + popover lineage + anchor + the element that hid it, and renders a task naming them. Re-arms every 6h.",
  contributions: [
    ReportKind({
      kind: "popover-anchor-lost",
      schema: PopoverAnchorLostPayloadSchema,
      fingerprint: popoverAnchorLostFingerprint,
      meta: {
        tag: "[popover-anchor-lost]",
        notif: "A popover's anchor vanished while it was open",
        // `warning`: the popover stays usable (it keeps its last place).
        variant: "warning",
        notifCooldownMs: POPOVER_ANCHOR_LOST_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderPopoverAnchorLostTask,
    }),
  ],
} satisfies ServerPluginDefinition;
