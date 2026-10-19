import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { useActiveApp } from "@plugins/apps-core/web";
import {
  useSurfaceMode,
  placementHasAppThemeScope,
  usePlacementCapabilities,
} from "@plugins/apps-core/plugins/tabs/web";

/**
 * The theme scope owned by the focused full-surface app — or `undefined` when no
 * single app fills the surface (desktop / floating focus → global `:root`).
 *
 * Returns `app:<id>` when the surface mode is `themeScope:"app"` (`docked`
 * full-area or `solo` fullscreen) AND an app is active; otherwise `undefined`.
 * It decides the `:root` token values, via theme-engine's `ThemeInjector`, so
 * the base layer carries the focused full-surface app's theme (the "base layer
 * owns `:root`" model). The common single-docked-app case emits zero scoped
 * blocks and is frame-0 trivially correct.
 *
 * The app chrome (rail, tab bar, toaster) does NOT wear this: it wears its own
 * fixed theme (`apps-core/chrome-theme`), the same whichever app is focused.
 *
 * Provider-free, so it works outside `<TabsProvider>` (the `Core.Root`
 * `ThemeInjector`): `useActiveApp` resolves the focused app from the URL when
 * called outside a surface — reactive across focus switches, which mirror the
 * focused tab's route into the URL — and `useSurfaceMode` reads the
 * module-level surface-mode store.
 *
 * All THREE inputs are subscribed, including the placement set. This hook is
 * mounted in the first commit, before the surface body's effect fills the
 * placement registry; asking the registry directly meant computing "no app
 * theme scope" once and keeping it, which put the page's own `:root` tokens on
 * a different theme than the focused app.
 */
export function useRootThemeScope(): string | undefined {
  const activeApp = useActiveApp();
  const mode = useSurfaceMode();
  const placements = usePlacementCapabilities();
  return placementHasAppThemeScope(placements, mode) && activeApp
    ? appThemeScope(activeApp.id)
    : undefined;
}
