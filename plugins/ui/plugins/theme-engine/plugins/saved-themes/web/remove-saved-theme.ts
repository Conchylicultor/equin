import { useCallback } from "react";
import {
  EndpointError,
  useFetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import type { ThemeId } from "@plugins/ui/plugins/theme-engine/core";
import { whenNoScopeSelects } from "@plugins/ui/plugins/theme-engine/web";
import {
  deleteSavedTheme,
  SavedThemeInUseSchema,
  type ThemeScopeRef,
} from "../core";
import { useAwaitSavedThemesWrite } from "./await-saved-themes-write";

export type RemoveSavedThemeResult =
  | { kind: "removed"; reassigned: ThemeScopeRef[] }
  | { kind: "in-use"; usedBy: ThemeScopeRef[] };

/** Delete one saved theme — see `useRemoveSavedTheme`. */
export type RemoveSavedTheme = (
  id: ThemeId,
  opts: { reassign: boolean },
) => Promise<RemoveSavedThemeResult>;

/**
 * Delete saved theme `id`, and drop it from the theme list the painter reads —
 * through the subtree's transport and live-state pipeline. Stable per
 * transport.
 *
 * Without `reassign`, a theme some scope still selects is left alone and the
 * result names those scopes, so the caller can ask the user before retrying
 * with `reassign` — which first moves them to the Default theme.
 *
 * Resolves once every scope on this page has its new selection and the live
 * theme list has re-read the delete (`useAwaitSavedThemesWrite`), so the caller
 * sees the theme gone. Rejects with the endpoint's error for any other failure.
 *
 * Ordering is assumed, not guaranteed: the server moves the scopes (an
 * in-process config notify) before its delete transaction starts, so in
 * practice their new selections reach the page ahead of the list's
 * change-feed recompute. Nothing orders the two resources' pushes, though: a
 * config push that lags the list's shows one missing-theme frame. The order
 * this awaits in does not change that — the live list drops the theme when
 * its recompute lands. Tracked: task-1792600740-e0u219.
 */
export function useRemoveSavedTheme(): RemoveSavedTheme {
  const fetchEndpoint = useFetchEndpoint();
  const awaitSavedThemesWrite = useAwaitSavedThemesWrite();
  return useCallback(
    async (id, opts) => {
      let reassigned: ThemeScopeRef[];
      let watermark: string;
      try {
        ({ reassigned, watermark } = await fetchEndpoint(
          deleteSavedTheme,
          { id },
          { query: opts.reassign ? { reassign: true } : {} },
        ));
      } catch (err) {
        if (err instanceof EndpointError && err.status === 409) {
          return {
            kind: "in-use",
            usedBy: SavedThemeInUseSchema.parse(err.body).usedBy,
          };
        }
        throw err;
      }
      await whenNoScopeSelects(id);
      await awaitSavedThemesWrite(watermark);
      return { kind: "removed", reassigned };
    },
    [fetchEndpoint, awaitSavedThemesWrite],
  );
}
