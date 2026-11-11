import { useCallback } from "react";
import { useMediaQuery } from "@plugins/primitives/plugins/dom/plugins/render-mode/web";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { Apps } from "@plugins/apps-core/web";
import { useRootThemeScopeState } from "@plugins/apps-core/plugins/theme-scope/web";
import { useColorScheme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  appThemeScope,
  isAppThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { AppColorMode } from "@plugins/primitives/plugins/pane/core";
import type { ColorScheme } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  appColorModeConfig,
  effectiveColorMode,
  parseAppColorModeOverride,
  parseConfiguredColorMode,
  themeSelectionConfig,
  type AppColorModeOverride,
  type ConfiguredColorMode,
} from "../core";

export type ColorMode = ColorScheme;
export type { ConfiguredColorMode };

// Light/dark is PER REGION. Each app wears its own effective scheme on its own
// boundary (`<Theme name="app:<id>">` stamps `data-color-scheme`, published by
// `ColorSchemePublisher`), each fixed theme its own, and `<html>` the
// desktop's (the global setting). Nothing follows focus: focusing an app or
// switching the surface mode changes no region's scheme, so it restyles
// nothing — only the document canvas (`<body>`'s background) follows the
// focused full-surface app, as one non-inherited property on one element.
//
// WHAT a scope wears: `effectiveColorMode` (core) — the app's override if the
// user set one, else its declared default (`defineApp({ colorMode })`),
// `global` meaning the base document's setting. The server's first frame calls
// the same function.
//
// Readers: `useColorMode()` is the scheme of the REGION a component renders in
// (the nearest boundary's — theme-boundary's `useColorScheme`), for whatever
// themes itself in JS. `useColorModeSetting()` is the setting the light/dark
// controls show and edit: the focused full-surface app's, else the global one.

/** The colour-mode setting of one scope, every layer of it. */
export interface ColorModeSetting {
  /** The base document's setting. */
  global: ConfiguredColorMode;
  /** The app's half — absent for the desktop (no app scope). */
  app?: {
    id: string;
    /** `defineApp({ colorMode })`; undefined = it follows the global setting. */
    declared: AppColorMode | undefined;
    /** The user's per-app choice. */
    override: AppColorModeOverride;
  };
  /** What the scope wears, before `system` is collapsed against the OS. */
  effective: ConfiguredColorMode;
}

/**
 * The colour-mode setting of app `appId` (`undefined`: the desktop). For a
 * surface that edits a named app's scheme (the customizer); what the document
 * wears is {@link useColorModeSetting}.
 */
export function useColorModeSettingFor(
  appId: string | undefined,
): ColorModeSetting {
  const global = parseConfiguredColorMode(
    useConfig(themeSelectionConfig).colorMode,
  );
  const override = parseAppColorModeOverride(
    useConfig(appColorModeConfig, {
      scopeId: appId === undefined ? undefined : appThemeScope(appId),
    }).colorMode,
  );
  const apps = Apps.App.useContributions();
  if (appId === undefined) return { global, effective: global };
  const declared = apps.find((a) => a.id === appId)?.app.colorMode;
  const app = { id: appId, declared, override };
  return { global, app, effective: effectiveColorMode(global, app) };
}

/** The app an `app:<id>` root scope names; undefined for the desktop. */
export function appIdOf(scopeId: string | undefined): string | undefined {
  return scopeId !== undefined && isAppThemeScope(scopeId)
    ? scopeId.slice(scopeId.indexOf(":") + 1)
    : undefined;
}

/**
 * The setting of the scope that owns this document's light/dark, with its
 * writer — or `{ known: false }` before the surface has said which app owns
 * `:root`. Not the desktop's setting meanwhile: a control would show (and a
 * click would write) the global scheme while the page wears an app's.
 *
 * `setColorMode` sets that scope's scheme: the focused app's override, or the
 * global setting when no app fills the surface. It names its scope through the
 * same state the class is painted from, so it cannot flip a value nothing
 * paints from — the bug the light/dark switch once had, writing one scope while
 * the class read another — and there is no writer while the scope is unknown.
 */
export type RootColorModeSetting =
  | { known: false }
  | {
      known: true;
      setting: ColorModeSetting;
      /** What that scope wears now: `system` collapsed against the OS, live. */
      resolved: ColorMode;
      setColorMode: (mode: ConfiguredColorMode) => void;
    };

export function useColorModeSetting(): RootColorModeSetting {
  const root = useRootThemeScopeState();
  const setting = useColorModeSettingFor(
    root.known ? appIdOf(root.scopeId) : undefined,
  );
  const app = setting.app;
  const setGlobal = useSetGlobalColorMode();
  const setApp = useSetConfig(appColorModeConfig, {
    scopeId: app === undefined ? undefined : appThemeScope(app.id),
  });
  const setColorMode = useCallback(
    (mode: ConfiguredColorMode) => {
      if (app === undefined) setGlobal(mode);
      else setApp("colorMode", mode);
    },
    [app, setGlobal, setApp],
  );
  const systemDark = useSystemDark();
  if (!root.known) return { known: false };
  return {
    known: true,
    setting,
    resolved: resolveColorMode(setting.effective, systemDark),
    setColorMode,
  };
}

/** Whether the OS prefers dark, live; light in a static render (no OS to ask). */
export function useSystemDark(): boolean {
  return useMediaQuery("(prefers-color-scheme: dark)", false);
}

/** A configured mode as worn: `system` collapsed against the OS. */
export function resolveColorMode(
  mode: ConfiguredColorMode,
  systemDark: boolean,
): ColorMode {
  return mode === "dark" || (mode === "system" && systemDark)
    ? "dark"
    : "light";
}

/**
 * The colour scheme of the region this component renders in — the nearest
 * scheme boundary's (an app's, a fixed theme's, a forced region's), else the
 * desktop's. Feed it to whatever themes itself through a prop
 * (`<Sonner theme={useColorMode()} />`, a chart, a highlighter) so it matches
 * the CSS around it.
 */
export function useColorMode(): ColorMode {
  return useColorScheme();
}

/**
 * Sets app `appId`'s override (`default` drops back to its declared default).
 * Its own document, so it never forks the app's theme.
 */
export function useSetAppColorMode(
  appId: string,
): (mode: AppColorModeOverride) => void {
  const set = useSetConfig(appColorModeConfig, {
    scopeId: appThemeScope(appId),
  });
  return useCallback(
    (mode: AppColorModeOverride) => set("colorMode", mode),
    [set],
  );
}

/** Sets the global setting — what every app following it wears. */
export function useSetGlobalColorMode(): (mode: ConfiguredColorMode) => void {
  const set = useSetConfig(themeSelectionConfig);
  return useCallback(
    (mode: ConfiguredColorMode) => set("colorMode", mode),
    [set],
  );
}
