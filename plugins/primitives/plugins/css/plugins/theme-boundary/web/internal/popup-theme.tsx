import { PortalThemeScopeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type React from "react";
import { ColorSchemeProvider, usePublishedColorScheme } from "./color-scheme";

export interface PopupThemeProps {
  /** Scope token the popups opened from here wear — `fixedThemeScope(…)`,
   *  `appThemeScope(id)`, …. */
  name: string;
  children?: React.ReactNode;
}

/**
 * The popups opened from here — popovers, menus, tooltips, dialogs — wear theme
 * `name`; the region itself keeps the theme around it. No element and no paint:
 * nothing in the region changes, so there is nothing to paint.
 *
 * The inverse of a sub-theme (which reaches the region, not its popups). The
 * case is a control that sits inside an app but opens part of the frame: the
 * app launcher's button lives in the app's own header, drawn in the app's
 * theme, while the app grid it opens is the chrome.
 *
 * The popup's icons follow: a floating panel draws its icons in the scope its
 * portal re-stamps (`OverlayPanel`).
 */
export function PopupTheme({ name, children }: PopupThemeProps) {
  // The popups wear the scope's scheme too (the chrome's dark), re-stamped
  // with its token; the region keeps its own.
  const scheme = usePublishedColorScheme(name);
  return (
    <PortalThemeScopeProvider scope={name} popupsOnly>
      <ColorSchemeProvider scheme={scheme} reach="popups">
        {children}
      </ColorSchemeProvider>
    </PortalThemeScopeProvider>
  );
}
