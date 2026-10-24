import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import { IconFamilyGapPayloadSchema, iconFamilyGapFingerprint } from "../core";
import {
  renderIconFamilyGapTask,
  ICON_FAMILY_GAP_NOTIF_COOLDOWN_MS,
} from "./internal/icon-family-gap-task";

export default {
  description:
    "Icon-family-gap report kind: validates the payload <Icon> files when a scope whose icon family is strict draws a symbol the family does not map (the scope shows the family's gap glyph), fingerprints by (family, name), and renders a task asking for the missing glyph.",
  contributions: [
    ReportKind({
      kind: "icon-family-gap",
      schema: IconFamilyGapPayloadSchema,
      fingerprint: iconFamilyGapFingerprint,
      meta: {
        tag: "[icon-family-gap]",
        notif: "A strict icon family has no glyph for a symbol it draws",
        // `warning`: the app still works; one icon is a dashed placeholder.
        variant: "warning",
        notifCooldownMs: ICON_FAMILY_GAP_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderIconFamilyGapTask,
    }),
  ],
} satisfies ServerPluginDefinition;
