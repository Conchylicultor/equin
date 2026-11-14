import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  ThemeResolutionPayloadSchema,
  themeResolutionFingerprint,
} from "../core";
import {
  renderThemeResolutionTask,
  THEME_RESOLUTION_NOTIF_COOLDOWN_MS,
} from "./internal/theme-resolution-task";

export default {
  description:
    "Theme-resolution report kind: validates the theme painter's fault payloads (a scope selecting a theme that does not exist, so it paints Default; a stored theme carrying values for an unregistered token group or unknown tokens, which are skipped), fingerprints each by what it is about, and renders a task naming the stored data to fix.",
  contributions: [
    ReportKind({
      kind: "theme-resolution",
      schema: ThemeResolutionPayloadSchema,
      fingerprint: themeResolutionFingerprint,
      meta: {
        tag: "[theme-resolution]",
        notif: "A theme could not be painted as stored",
        // `warning`, not `error`: the app still paints — Default for a missing
        // theme, the rest of the theme for skipped values.
        variant: "warning",
        category: "error",
        notifCooldownMs: THEME_RESOLUTION_NOTIF_COOLDOWN_MS,
      },
      renderTask: renderThemeResolutionTask,
    }),
  ],
} satisfies ServerPluginDefinition;
