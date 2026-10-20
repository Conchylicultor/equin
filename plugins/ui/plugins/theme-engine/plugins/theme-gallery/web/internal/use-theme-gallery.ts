import { useMemo, useState } from "react";
import { useConfigResult, useSetConfig } from "@plugins/config_v2/web";
import { Apps } from "@plugins/apps-core/web";
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  combineResources,
  type PortableGateInput,
} from "@plugins/primitives/plugins/live-state/web";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import {
  resolveTheme,
  themeSelectionConfig,
  transformValues,
  type Theme,
  type ThemeId,
} from "@plugins/ui/plugins/theme-engine/core";
import {
  ThemeEngine,
  useThemes,
  useThemeScopeId,
  useThemeSelections,
  type ThemeSourceFailure,
} from "@plugins/ui/plugins/theme-engine/web";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import {
  buildThemeRows,
  residentRowKey,
  type ThemePreview,
  type ThemeRow,
} from "./theme-rows";
import { useBrowseListings } from "./use-browse-listings";

export type ThemeGalleryState =
  | { pending: true }
  | {
      pending: false;
      rows: ThemeRow[];
      /** The row of the theme the scope selects; absent when that theme does not exist. */
      selectedKey: string | undefined;
      /** The scope's selection when it names a theme that does not exist (the scope paints Default). */
      missing: ThemeId | undefined;
      /** The name the gallery uses for the scope it is picking for. */
      scopeLabel: string;
      /**
       * Theme sources (resident or browse) whose read FAILED: the rows hold
       * every theme that could be read, and the gallery says which source
       * could not be, with its Retry.
       */
      failures: readonly ThemeSourceFailure[];
    };

export interface ThemeGallery {
  /**
   * Whether the gallery can show its rows: loading, ready, or FAILED (the
   * scope's selection could not be read) with its retry — what the DataView
   * renders its loading / error chrome from.
   */
  readiness: ResourceReadiness;
  /** The rows once `readiness` is ready; pending while loading or failed. */
  state: ThemeGalleryState;
  /** Select the row's theme for the scope — saving a catalog entry first. */
  activate: (row: ThemeRow) => Promise<void>;
  /** The catalog row whose save is in flight, dimmed until it lands. */
  adoptingKey: string | null;
}

/** The name a scope goes by in the gallery: the desktop, or the app it belongs to. */
export function useScopeLabel(): (scopeId: string | undefined) => string {
  const apps = Apps.App.useContributions();
  return useMemo(() => {
    const names = new Map(
      apps.map((a) => [appThemeScope(a.id), a.app.name] as const),
    );
    return (scopeId) =>
      scopeId === undefined ? "Desktop" : (names.get(scopeId) ?? scopeId);
  }, [apps]);
}

// A swatch is the theme's color palette, as the scope would paint it — its
// color adjustment included. Resolving over the palette group ALONE is
// deliberate: every other group's fragment then comes back in `skipped` as
// unregistered, which here says nothing about the theme — the painter reports
// what it genuinely drops.
function previewOf(
  theme: Theme,
  themesById: ReadonlyMap<ThemeId, Theme>,
): ThemePreview {
  const { theme: resolved } = resolveTheme(theme.id, themesById, [
    colorPaletteGroup,
  ]);
  const palette = resolved.groups[colorPaletteGroup.id];
  if (!palette) {
    throw new Error(
      `[theme-gallery] resolving "${theme.id}" over the color palette group returned no palette values`,
    );
  }
  return {
    light: transformValues(palette.light, resolved.colorAdjust),
    dark: transformValues(palette.dark, resolved.colorAdjust),
  };
}

/**
 * Everything the Theme DataView shows, for the scope of the surrounding
 * `ThemeScopeProvider`: one row per theme (every resident theme, plus every
 * catalog entry not saved yet), which of them the scope selects, and the
 * gesture that selects one.
 *
 * Pending until the theme list, every catalog, and every scope's selection are
 * known — the gallery renders a loading state until then, never a partial list
 * — and an error (with retry) when the scope's selection failed to load.
 */
/**
 * A theme-engine state that cannot fail as a whole (a failing source rides in
 * its value as a `failures` entry), as a gate input: loading until it settles.
 */
function settledGate(state: { pending: boolean }): PortableGateInput {
  return { status: state.pending ? "loading" : "ready" };
}

export function useThemeGallery(): ThemeGallery {
  const scopeId = useThemeScopeId();
  const themes = useThemes();
  const browse = useBrowseListings();
  const selections = useThemeSelections();
  const selection = useConfigResult(themeSelectionConfig, { scopeId });
  const scopeLabel = useScopeLabel();
  const sources = ThemeEngine.ThemeSource.useContributions();
  const selectTheme = useSetConfig(themeSelectionConfig, { scopeId });
  const [adoptingKey, setAdoptingKey] = useState<string | null>(null);

  const readiness = useMemo(
    () =>
      combineResources({
        themes: settledGate(themes),
        browse: settledGate(browse),
        selections: settledGate(selections),
        selection,
      }),
    [themes, browse, selections, selection],
  );

  const state = useMemo((): ThemeGalleryState => {
    if (
      themes.pending ||
      browse.pending ||
      selections.pending ||
      // Loading or failed: no rows either way — `readiness` tells them apart.
      selection.status === "loading" ||
      selection.status === "error"
    ) {
      return { pending: true };
    }
    const { themesById } = themes;
    const rows = buildThemeRows({
      themes: [...themesById.values()],
      browse: browse.listings,
      selections: selections.selections,
      scopeLabel,
      previewOf: (theme) => previewOf(theme, themesById),
    });
    const selected = selection.data.theme;
    const exists = themesById.has(selected);
    // A selection absent while a resident source failed is unknown, not
    // missing — the failure notice is the honest message (see useResolvedTheme).
    const missing = exists || themes.failures.length > 0 ? undefined : selected;
    return {
      pending: false,
      rows,
      selectedKey: exists ? residentRowKey(selected) : undefined,
      missing,
      scopeLabel: scopeLabel(scopeId),
      failures: [...themes.failures, ...browse.failures],
    };
  }, [themes, browse, selections, selection, scopeLabel, scopeId]);

  const activate = async (row: ThemeRow): Promise<void> => {
    const { target } = row;
    if (target.kind === "resident") {
      selectTheme("theme", target.theme.id);
      return;
    }
    const source = sources.find(
      (s) => s.kind === "browse" && s.id === target.sourceId,
    );
    if (source?.kind !== "browse") {
      throw new Error(
        `[theme-gallery] row "${row.key}" comes from browse source "${target.sourceId}", which is not registered`,
      );
    }
    setAdoptingKey(row.key);
    try {
      // `adopt` resolves once the theme list already has the saved theme, so
      // selecting it never paints a missing theme in between.
      selectTheme("theme", await source.adopt(target.entryId));
    } catch (err) {
      // Already reported by the endpoint layer (the global error toast); the
      // card simply stays a catalog entry, clickable again.
      if (err instanceof EndpointError) return;
      throw err;
    } finally {
      setAdoptingKey(null);
    }
  };

  return { readiness, state, activate, adoptingKey };
}
