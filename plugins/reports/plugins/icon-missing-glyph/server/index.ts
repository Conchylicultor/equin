import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  IconMissingGlyphPayloadSchema,
  iconMissingGlyphFingerprint,
} from "../core";
import {
  renderIconMissingGlyphTask,
  ICON_MISSING_GLYPH_NOTIF_COOLDOWN_MS,
} from "./internal/icon-missing-glyph-task";

export default {
  description:
    "Icon-missing-glyph report kind: validates the payload <Icon> files when a held sprite has no symbol for an icon it draws (the build's icon manifest missed the name; the icon shows the missing-glyph marker), fingerprints by (sprite, symbol id), and renders a task pointing at icons:manifest-covers-uses.",
  contributions: [
    ReportKind({
      kind: "icon-missing-glyph",
      schema: IconMissingGlyphPayloadSchema,
      fingerprint: iconMissingGlyphFingerprint,
      meta: {
        tag: "[icon-missing-glyph]",
        notif: "An icon has no symbol in its sprite",
        // `error`: a shipped icon is broken — a build bug, not a design gap.
        variant: "error",
        notifCooldownMs: ICON_MISSING_GLYPH_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderIconMissingGlyphTask,
    }),
  ],
} satisfies ServerPluginDefinition;
