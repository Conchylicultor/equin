import { useInsertionEffect, useSyncExternalStore } from "react";
import { Apps } from "@plugins/apps-core/web";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import { usePublishColorScheme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  appThemeScope,
  COLOR_SCHEME_ATTR,
  fixedThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { ThemeEngine } from "../slots";
import {
  resolveColorMode,
  useColorModeSettingFor,
  useSystemDark,
  type ColorMode,
} from "../use-color-mode";
import type { FixedTheme } from "../../core";

// ── A transient preview of one scope's scheme ──────────────────────────────
//
// The theme customizer shows the tokens it edits in light or dark without
// writing the setting: it overrides the scheme ONE scope wears while it is
// mounted. Keyed by app id (`""` = the desktop). Page-global like the scheme
// store it feeds: a scope's scheme is the same in every surface.

const ROOT_PREVIEW = "";
/** Every mounted preview of a scope, oldest first: the latest one wins. */
const previews = new Map<string, { mode: ColorMode }[]>();
const previewListeners = new Set<() => void>();

function subscribePreviews(listener: () => void): () => void {
  previewListeners.add(listener);
  return () => previewListeners.delete(listener);
}

function usePreview(appId: string | undefined): ColorMode | undefined {
  const key = appId ?? ROOT_PREVIEW;
  return useSyncExternalStore(
    subscribePreviews,
    () => previews.get(key)?.at(-1)?.mode,
  );
}

/**
 * Shows app `appId` (undefined = the desktop) in `mode` while mounted, without
 * touching its setting; undefined `mode` previews nothing. Two customizers on
 * one scope (two tabs, both kept alive): the one mounted last wins until it
 * goes.
 */
export function usePreviewColorScheme(
  appId: string | undefined,
  mode: ColorMode | undefined,
): void {
  const key = appId ?? ROOT_PREVIEW;
  useInsertionEffect(() => {
    if (mode === undefined) return;
    const entry = { mode };
    previews.set(key, [...(previews.get(key) ?? []), entry]);
    for (const l of previewListeners) l();
    return () => {
      const rest = (previews.get(key) ?? []).filter((e) => e !== entry);
      if (rest.length === 0) previews.delete(key);
      else previews.set(key, rest);
      for (const l of previewListeners) l();
    };
  }, [key, mode]);
}

// ── The publisher ──────────────────────────────────────────────────────────

/**
 * Publishes the scheme every theme scope wears, for the boundaries to stamp
 * (theme-boundary's store): each app's effective colour mode, each fixed
 * theme's own scheme, and the desktop's for the root. A root host of every
 * scope: inside a `<PluginScope>` it publishes the scope's own (its root is
 * the scope's root boundary). On the page it also puts the desktop's scheme on
 * `<html>` — the one place `<html>` takes a scheme from, so it never follows
 * focus.
 */
export function ColorSchemePublisher() {
  const apps = Apps.App.useContributions();
  const fixedThemes = ThemeEngine.FixedTheme.useContributions();
  const pluginScope = usePluginScopeId();
  return (
    <>
      <RootScheme applyToDocument={pluginScope === null} />
      {apps.map((app) => (
        <AppScheme key={app.id} appId={app.id} />
      ))}
      {fixedThemes.map((fixed) => (
        <FixedScheme key={fixed.id} fixed={fixed} />
      ))}
    </>
  );
}

/** What scope `appId` (undefined = the desktop) wears now, preview included. */
function useWornScheme(appId: string | undefined): ColorMode {
  const effective = useColorModeSettingFor(appId).effective;
  const systemDark = useSystemDark(effective === "system");
  const preview = usePreview(appId);
  return preview ?? resolveColorMode(effective, systemDark);
}

function RootScheme({ applyToDocument }: { applyToDocument: boolean }) {
  const scheme = useWornScheme(undefined);
  usePublishColorScheme(undefined, scheme);
  // An insertion effect, so `<html>` carries it before any layout effect of
  // the commit can force a style recalc (theme-injector's usePaintedStyle).
  useInsertionEffect(() => {
    if (!applyToDocument) return;
    document.documentElement.setAttribute(COLOR_SCHEME_ATTR, scheme);
  }, [applyToDocument, scheme]);
  return null;
}

function AppScheme({ appId }: { appId: string }) {
  usePublishColorScheme(appThemeScope(appId), useWornScheme(appId));
  return null;
}

function FixedScheme({ fixed }: { fixed: FixedTheme }) {
  usePublishColorScheme(fixedThemeScope(fixed), fixed.scheme);
  return null;
}
