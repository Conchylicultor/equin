import { defineConfig } from "@plugins/config_v2/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";
import {
  APP_COLOR_MODES,
  type AppColorMode,
} from "@plugins/primitives/plugins/pane/core";
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
    // The GLOBAL scheme, read from the base document only: dark by default,
    // whatever the OS prefers — every app is designed dark first. An app
    // follows it unless it declares its own (`defineApp({ colorMode })`) or the
    // user overrides it (`appColorModeConfig`); a value in an app's theme
    // document is never read.
    colorMode: enumField({
      default: "dark",
      options: ["light", "dark", "system"],
      label: "Color mode",
    }),
  },
});

/** A CONFIGURED light/dark setting, before `system` is collapsed against the OS. */
export type ConfiguredColorMode = "light" | "dark" | "system";

/**
 * The user's per-app colour-scheme override: `default` keeps the app's declared
 * default (`defineApp({ colorMode })`), anything else replaces it — `global`
 * included, which makes an app that declares its own scheme follow the global
 * setting after all.
 */
export type AppColorModeOverride = (typeof APP_COLOR_MODE_OVERRIDES)[number];

const APP_COLOR_MODE_OVERRIDES = ["default", ...APP_COLOR_MODES] as const;

const CONFIGURED_COLOR_MODES: readonly string[] = ["light", "dark", "system"];

/**
 * The two colour-mode fields as their closed unions. An enum field stores a
 * `string`; its schema already admits only the declared options, so anything
 * else here is a broken invariant and throws rather than paint a guess.
 */
export function parseConfiguredColorMode(value: string): ConfiguredColorMode {
  if (CONFIGURED_COLOR_MODES.includes(value))
    return value as ConfiguredColorMode;
  throw new Error(`[theme-engine] not a color mode: "${value}"`);
}

export function parseAppColorModeOverride(value: string): AppColorModeOverride {
  if ((APP_COLOR_MODE_OVERRIDES as readonly string[]).includes(value)) {
    return value as AppColorModeOverride;
  }
  throw new Error(`[theme-engine] not an app color-mode override: "${value}"`);
}

/**
 * Per-app colour scheme, apart from the theme choice: an app's own document
 * (`@app/<id>/color-mode.jsonc`) holds the user's override. Its own descriptor
 * rather than a field of {@link themeSelectionConfig} because an app's theme
 * document IS "this app has its own theme" — writing light/dark there would
 * fork the app's theme (fork-on-write snapshots the whole document), so
 * switching one app to light would silently freeze its theme too.
 *
 * Not `scope: "app"`: "Customize for <App>" forks the theme, not the scheme.
 * A scope without its own document reads the base one, whose `default` means
 * "every app keeps its declared default".
 */
export const appColorModeConfig = defineConfig({
  name: "color-mode",
  fields: {
    colorMode: enumField({
      default: "default",
      options: [...APP_COLOR_MODE_OVERRIDES],
      label: "Color mode",
    }),
  },
});

/**
 * THE resolution of a document's light/dark setting — the one function both the
 * browser (the `.dark` class applier, every colour-mode hook) and the server
 * (the first frame's `.dark` script) call, so the two cannot paint different
 * schemes. `app` is the app owning the document (the focused full-surface app;
 * `undefined` for the desktop / no app), `global` the base document's setting.
 */
export function effectiveColorMode(
  global: ConfiguredColorMode,
  app:
    | { declared: AppColorMode | undefined; override: AppColorModeOverride }
    | undefined,
): ConfiguredColorMode {
  if (app === undefined) return global;
  const mode =
    app.override === "default" ? (app.declared ?? "global") : app.override;
  return mode === "global" ? global : mode;
}
