import { defineConfig } from "@plugins/config_v2/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import { DEFAULT_THEME_ID } from "./theme";

/**
 * A scope's ONE theme choice — the desktop's (the base document) or one app's
 * (`@app/<id>/theme.jsonc`). This is the document the theme painter reads: a
 * scope stores which `Theme` paints it, never a setting per token group, so an
 * app cannot own part of a theme and inherit the rest from the desktop.
 *
 * Its own name (`theme`, not `config`) so the per-group documents written under
 * the old model become orphans the orphan audit lists, rather than stale-hash
 * conflicts against a reshaped schema.
 */
export const themeSelectionConfig = defineConfig({
  name: "theme",
  scope: "app",
  fields: {
    theme: dynamicEnumField({ default: DEFAULT_THEME_ID, label: "Theme" }),
    // Dark by default, whatever the OS prefers: every app is designed dark
    // first. Light (or following the OS) stays an explicit choice.
    colorMode: enumField({
      default: "dark",
      options: ["light", "dark", "system"],
      label: "Color mode",
    }),
  },
});

/**
 * THE config scope that owns light/dark: the desktop's (the base document,
 * `undefined`). Per-scope dark mode is DEFERRED — `<html>.dark` is one global
 * class — so every reader of color mode resolves here: the browser's class
 * applier and color-mode hooks (`web/use-color-mode.ts`, which explains how
 * readers at different scopes once painted a white frame under a dark page)
 * and the server painting the first frame's class into the HTML. Named once,
 * in core, so neither runtime can read another scope. When per-scope dark
 * lands, this is the one place that changes.
 */
export const COLOR_MODE_SCOPE_ID: string | undefined = undefined;
