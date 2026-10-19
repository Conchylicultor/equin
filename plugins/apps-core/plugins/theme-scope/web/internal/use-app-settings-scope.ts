import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { useEnclosingAppThemeScope } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { useCurrentAppId } from "@plugins/apps-core/web";

/**
 * The `app:<id>` config scope a component's per-app theme settings (a variant
 * region, the progress-bar style) are read in: the app whose theme the
 * component wears.
 *
 * Inside a theme boundary that is the nearest APP boundary — a pane's HOME app
 * (`PaneBox` stamps `Pane.define({ app })`), so a conversation pane opened in
 * Pages reads the agent manager's overrides exactly as its colours already do.
 * Reading the hosting surface's app instead is what made the same pane look
 * different in every app that hosts it.
 *
 * Outside every app boundary (the app chrome: rail, tab bar, action bar) it is
 * the focused app's, as {@link useCurrentAppId} resolves it. Undefined when
 * neither exists — the base config.
 */
export function useAppSettingsScope(): string | undefined {
  const enclosing = useEnclosingAppThemeScope();
  const appId = useCurrentAppId();
  if (enclosing !== undefined) return enclosing;
  return appId === undefined ? undefined : appThemeScope(appId);
}
