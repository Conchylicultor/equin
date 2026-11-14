import { useMemo } from "react";
import { paintedTokenGroups, type TokenGroupSpec } from "../../core";
import { ThemeEngine } from "../slots";

/**
 * The token groups this scope's painters paint and resolve over: the registered
 * ones plus every group a contributed code theme names (`paintedTokenGroups`),
 * so a code theme's fragment always has its group — even when the group's
 * registering plugin did not load.
 */
export function usePaintedTokenGroups(): readonly TokenGroupSpec[] {
  const registered = ThemeEngine.TokenGroup.useContributions();
  const themes = ThemeEngine.Theme.useContributions();
  const subThemes = ThemeEngine.SubTheme.useContributions();
  const fixedThemes = ThemeEngine.FixedTheme.useContributions();
  const registeredSpecs = useMemo(
    () => registered.map((g) => g.descriptor),
    [registered],
  );
  return useMemo(
    () =>
      paintedTokenGroups(registeredSpecs, [
        ...themes,
        ...subThemes,
        ...fixedThemes,
      ]),
    [registeredSpecs, themes, subThemes, fixedThemes],
  );
}
