import { useCallback, useMemo } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  combineResources,
  mapResource,
  type PortableGateInput,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import type { ThemeId } from "@plugins/ui/plugins/theme-engine/core";
import {
  useThemes,
  type ThemeSourceEntry,
} from "@plugins/ui/plugins/theme-engine/web";
import { importedThemeId } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/core";
import { useAwaitSavedThemesWrite } from "@plugins/ui/plugins/theme-engine/plugins/saved-themes/web";
import { tweakcnPalettePreview } from "@plugins/ui/plugins/tweakcn/core";
import { applyCatalogTheme } from "../../core";
import { communityCatalog } from "../../shared/resources";

/**
 * The community catalog as browse-source entries. An entry already saved
 * carries the saved theme's id, so a picker can show it once (as the saved
 * theme) rather than twice. Loading while the catalog or the theme list is
 * still loading; a failed catalog read is the error arm (with Retry), never a
 * forever-loading or empty catalog.
 *
 * The catalog's curated (tweakcn registry) themes have no tags of their own;
 * they are tagged `curated` so a picker can filter on it.
 */
export function useCatalogEntries(): ResourceResult<ThemeSourceEntry[]> {
  const catalog = useLive(communityCatalog);
  const themes = useThemes();

  return useMemo(
    () =>
      // The theme list only marks entries already saved; while it loads the
      // catalog waits too, so an entry never flips from "unsaved" to "saved".
      mapResource(
        combineResources({ catalog, themes: themesGate(themes.pending) }),
        ({ catalog: data }) => {
          const saved = themes.pending ? null : themes.themesById;
          return data.themes.map((theme): ThemeSourceEntry => {
            const savedId = importedThemeId("tweakcn", theme.id);
            return {
              id: theme.id,
              label: theme.name,
              tags:
                theme.source === "registry"
                  ? ["curated", ...theme.tags]
                  : theme.tags,
              preview: tweakcnPalettePreview(theme.cssVars),
              ...(saved?.has(savedId) ? { savedThemeId: savedId } : {}),
            };
          });
        },
      ),
    [catalog, themes],
  );
}

/**
 * The theme list as a gate input: it cannot fail as a whole (a failing source
 * rides in its value as a `failures` entry), so it is loading until it settles.
 */
function themesGate(pending: boolean): PortableGateInput {
  return { status: pending ? "loading" : "ready" };
}

/**
 * The catalog source's adopt, through the subtree's transport and live-state
 * pipeline: save catalog theme `entryId` and resolve to its saved theme's id —
 * once the theme list the painter reads already has it, so the caller can
 * select it without a frame of "missing theme". Rejects with the endpoint's
 * error.
 */
export function useAdoptCatalogTheme(): (entryId: string) => Promise<ThemeId> {
  const fetchEndpoint = useFetchEndpoint();
  const awaitSavedThemesWrite = useAwaitSavedThemesWrite();
  return useCallback(
    async (entryId: string) => {
      const { theme, watermark } = await fetchEndpoint(
        applyCatalogTheme,
        {},
        { body: { themeId: entryId } },
      );
      await awaitSavedThemesWrite(watermark);
      return theme.id;
    },
    [fetchEndpoint, awaitSavedThemesWrite],
  );
}
