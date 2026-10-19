import { createContext, useContext, type ReactNode } from "react";
import { isAppThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

// The `app:<id>` token of the nearest APP theme boundary, or undefined outside
// every one. Fixed (`fixed:`) and sub-theme (`sub:`) boundaries do not move it:
// they restyle a region, they do not change whose app the region belongs to.
// React context, so it crosses portals the way the theme does.
const AppThemeScopeContext = createContext<string | undefined>(undefined);

/**
 * Publishes `scope` as the enclosing app theme scope when it names one; any
 * other token (or undefined) keeps the enclosing app scope. Rendered by
 * `<Theme>` only.
 */
export function AppThemeScopeProvider({
  scope,
  children,
}: {
  scope: string | undefined;
  children: ReactNode;
}) {
  const parent = useContext(AppThemeScopeContext);
  const value = scope !== undefined && isAppThemeScope(scope) ? scope : parent;
  return (
    <AppThemeScopeContext.Provider value={value}>
      {children}
    </AppThemeScopeContext.Provider>
  );
}

/**
 * The app theme scope (`app:<id>`) this subtree wears: the nearest `<Theme>`
 * boundary that names an app — a pane's HOME app (`PaneBox`), else the tab's
 * app — or undefined outside every app boundary (the app chrome).
 *
 * This is the JS twin of what the CSS cascade resolves for the design tokens,
 * so a setting an app overrides in its `app:<id>` config scope (a variant, a
 * progress-bar style) follows the same region the app's colours do: a pane
 * looks the same in whichever app hosts it.
 */
export function useEnclosingAppThemeScope(): string | undefined {
  return useContext(AppThemeScopeContext);
}
