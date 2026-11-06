import { getConfig, getConfigScopeIds } from "@plugins/config_v2/server";
import { themeSelectionConfig } from "@plugins/ui/plugins/theme-engine/core";
import type { ThemeSelection } from "./delete-plan";

/**
 * Every scope's theme choice: the desktop's (the base document) plus every
 * scope with its own document. A scope without one inherits the desktop's
 * choice, so it is covered by the base entry rather than listed.
 */
export async function readThemeSelections(): Promise<ThemeSelection[]> {
  return [
    { themeId: getConfig(themeSelectionConfig).theme },
    ...(await getConfigScopeIds(themeSelectionConfig)).map((scopeId) => ({
      scopeId,
      themeId: getConfig(themeSelectionConfig, scopeId).theme,
    })),
  ];
}
