import type { ReactNode } from "react";
import {
  PortalForwardProvider,
  usePortalForwardedAttrs,
} from "./portal-forward";
import { usePluginScopeId } from "@plugins/framework/plugins/web-sdk/core";
import { bareThemeScope, isSubThemeScope, qualifyThemeScope } from "../../core";

/** The DOM attribute this signal rides across portals on. */
const THEME_SCOPE_ATTR = "data-theme-scope";

/** Theme-scope token (e.g. "app:home") to stamp on portaled content so it
 *  inherits the originating surface's scoped theme instead of the global :root
 *  chrome theme. Undefined → no attribute → default (global) theme.
 *
 *  Theme scope is the first consumer of the generic {@link PortalForwardProvider}
 *  bridge: it forwards `data-theme-scope` exactly the way plugin lineage and pane
 *  id forward theirs, so portal surfaces re-stamp every forwarded signal at once. */
export function usePortalThemeScope(): string | undefined {
  const pluginScope = usePluginScopeId();
  const forwarded = usePortalForwardedAttrs()[THEME_SCOPE_ATTR];
  // The attribute is qualified by the plugin scope it was stamped in
  // (`qualifyThemeScope`); a reader wants the bare token.
  return forwarded === undefined
    ? undefined
    : bareThemeScope(pluginScope, forwarded);
}

export function PortalThemeScopeProvider({
  scope,
  popupsOnly = false,
  children,
}: {
  scope: string | undefined;
  /** Forward the scope to popups opened from here only — the region itself
   *  (and content relocated within it) keeps the scope from above. */
  popupsOnly?: boolean;
  children: ReactNode;
}) {
  // A sub-theme is region-only: a popup opened from inside it wears the theme
  // around the sub-theme, while content relocated within the region keeps it.
  const reach = popupsOnly
    ? "popups"
    : scope !== undefined && isSubThemeScope(scope)
      ? "region"
      : "all";
  // Re-stamped as the DOM attribute, so qualified by the plugin scope like
  // `<Theme>`'s own (a page block must not match a scope's popup).
  const pluginScope = usePluginScopeId();
  const stamped =
    scope === undefined ? undefined : qualifyThemeScope(pluginScope, scope);
  return (
    <PortalForwardProvider
      name={THEME_SCOPE_ATTR}
      value={stamped}
      reach={reach}
    >
      {children}
    </PortalForwardProvider>
  );
}
