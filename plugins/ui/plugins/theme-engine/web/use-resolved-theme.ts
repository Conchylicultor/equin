import { useMemo } from "react";
import { useConfigResult } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  DEFAULT_THEME_ID,
  resolveTheme,
  themeSelectionConfig,
  type ResolvedTheme,
  type SkippedThemeValue,
  type ThemeId,
} from "../core";
import { ThemeEngine, useThemes } from "./slots";

export type ResolvedThemeState =
  | { pending: true }
  | {
      pending: false;
      /** The theme the scope paints: its selection, or Default when that selection names no theme. */
      themeId: ThemeId;
      /**
       * The selection when it names a theme that does not exist (a hand-edited
       * config file, a deleted import) — the scope paints Default instead.
       * Never silent: the painter reports it.
       */
      missing?: ThemeId;
      theme: ResolvedTheme;
      /** Persisted values the resolver dropped (a retired token group or token) — reported by the painter. */
      skipped: SkippedThemeValue[];
    };

/**
 * What scope `scopeId` paints (undefined = the desktop): its selected theme,
 * resolved over every registered token group.
 *
 * A scope without its own theme document reads the desktop's selection — the
 * inheritance is config_v2's, so this and the painter's membership gate agree.
 * Pending while the selection or any resident theme source is still loading:
 * the painter injects nothing then, so the server-painted first-frame CSS stays
 * on screen instead of being overwritten by a guess.
 *
 * A FAILED selection read is never pending: theme resolution runs before first
 * paint, and an error that blanked it would blank the app. It folds to the last
 * selection the server vouched for, else Default — the failure itself is
 * carried by live-state's resource-error report sink (Live reads health row).
 */
export function useResolvedTheme(
  scopeId: string | undefined,
): ResolvedThemeState {
  const themes = useThemes();
  const selection = useConfigResult(themeSelectionConfig, { scopeId });
  const groups = ThemeEngine.TokenGroup.useContributions();

  return useMemo((): ResolvedThemeState => {
    const selected = foldResource(selection, {
      loading: () => null,
      error: (_error, stale) => stale?.theme ?? DEFAULT_THEME_ID,
      ready: (data) => data.theme,
    });
    if (themes.pending || selected === null) return { pending: true };
    const { themesById } = themes;
    const exists = themesById.has(selected);
    const themeId = exists ? selected : DEFAULT_THEME_ID;
    const { theme, skipped } = resolveTheme(
      themeId,
      themesById,
      groups.map((g) => g.descriptor),
    );
    // A selection absent while a resident source FAILED may well be one of
    // that source's themes: whether it exists is unknown, so it paints Default
    // (never blank) without claiming it missing — the failure is the fault,
    // and the surfaces listing themes render it.
    return exists || themes.failures.length > 0
      ? { pending: false, themeId, theme, skipped }
      : { pending: false, themeId, missing: selected, theme, skipped };
  }, [themes, selection, groups]);
}
