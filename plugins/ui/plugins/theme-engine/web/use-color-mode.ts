import { useCallback, useEffect, useState } from "react";
import { useConfig, useSetConfig } from "@plugins/config_v2/web";
import { Apps } from "@plugins/apps-core/web";
import { useRootThemeScopeState } from "@plugins/apps-core/plugins/theme-scope/web";
import {
  appThemeScope,
  isAppThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { AppColorMode } from "@plugins/primitives/plugins/pane/core";
import {
  appColorModeConfig,
  effectiveColorMode,
  parseAppColorModeOverride,
  parseConfiguredColorMode,
  themeSelectionConfig,
  type AppColorModeOverride,
  type ConfiguredColorMode,
} from "../core";

export type ColorMode = "light" | "dark";
export type { ConfiguredColorMode };

// WHO decides light/dark. `<html>.dark` is one class per document, and the
// `color-scheme` property it drives is a document-level thing, so a document
// has ONE colour scheme: that of the scope owning `:root` — the focused
// full-surface app (`useRootThemeScope`), or the desktop when no single app
// fills the surface. Every reader below resolves at that scope, the class
// applier and the prop-themed widgets (sonner, charts, editors) alike, so they
// cannot render different schemes on one screen. (They once did: each call
// site picked its own scope, and a global `dark` beside an app-scoped `light`
// shipped a white first paint that flipped to dark once React mounted.)
//
// WHAT it is: `effectiveColorMode` (core) — the app's override if the user set
// one, else its declared default (`defineApp({ colorMode })`), `global`
// meaning the base document's setting. The server's first frame calls the same
// function for the app a page opens. A surface showing several apps at once
// (an unfocused floating window) wears the root's scheme: per-region schemes
// are still deferred.

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
function appIdOf(scopeId: string | undefined): string | undefined {
  return scopeId !== undefined && isAppThemeScope(scopeId)
    ? scopeId.slice(scopeId.indexOf(":") + 1)
    : undefined;
}

/** The setting of the scope that owns this document's light/dark. */
export function useColorModeSetting(): ColorModeSetting {
  const root = useRootThemeScopeState();
  return useColorModeSettingFor(root.known ? appIdOf(root.scopeId) : undefined);
}

/** Whether the OS prefers dark, live — subscribed only while `active`. */
function useSystemDark(active: boolean): boolean {
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    if (!active) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setSystemDark(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [active]);
  return systemDark;
}

function resolve(mode: ConfiguredColorMode, systemDark: boolean): ColorMode {
  return mode === "dark" || (mode === "system" && systemDark)
    ? "dark"
    : "light";
}

/**
 * The document's resolved scheme, or `undefined` before the surface has said
 * which app owns `:root`. The class applier waits that window out — the
 * server's first frame already set the class for the app the page opens, and
 * applying the desktop's answer meanwhile would flash.
 */
export function useDocumentColorMode(): ColorMode | undefined {
  const root = useRootThemeScopeState();
  const setting = useColorModeSettingFor(
    root.known ? appIdOf(root.scopeId) : undefined,
  );
  const systemDark = useSystemDark(setting.effective === "system");
  return root.known ? resolve(setting.effective, systemDark) : undefined;
}

// Resolves the effective light/dark mode, collapsing the `system` setting against
// the OS `prefers-color-scheme` (with a live listener). Both the `.dark` class
// applier and prop-themed third-party components (sonner, charts, editors)
// consume this resolution, so the class, the `color-scheme` property, and every
// JS widget agree. Before the owning scope is known it answers the scheme the
// document already wears (the class the server's first frame set), which is
// exactly what is on screen.
export function useResolvedColorMode(): ColorMode {
  const mode = useDocumentColorMode();
  if (mode !== undefined) return mode;
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// The resolved color mode — the same value driving the global `.dark` class. Use
// this to feed any component that themes itself via a prop (e.g.
// `<Sonner theme={useColorMode()} />`) instead of reading the class.
export function useColorMode(): ColorMode {
  return useResolvedColorMode();
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

/**
 * Sets the scheme of the scope that owns this document: the focused app's
 * override, or the global setting when no app fills the surface. The writer
 * names its scope through the same {@link useColorModeSetting} the class is
 * painted from, so it cannot flip a value nothing paints from — the bug the
 * light/dark switch once had, writing one scope while the class read another.
 */
export function useSetColorMode(): (mode: ConfiguredColorMode) => void {
  const { app } = useColorModeSetting();
  const setGlobal = useSetGlobalColorMode();
  const setApp = useSetConfig(appColorModeConfig, {
    scopeId: app === undefined ? undefined : appThemeScope(app.id),
  });
  return useCallback(
    (mode: ConfiguredColorMode) => {
      if (app === undefined) setGlobal(mode);
      else setApp("colorMode", mode);
    },
    [app, setGlobal, setApp],
  );
}
