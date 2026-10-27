import { appThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { useActiveApp } from "@plugins/apps-core/web";
import {
  useSurfaceMode,
  placementHasAppThemeScope,
  usePlacementCapabilities,
} from "@plugins/apps-core/plugins/tabs/web";

export type RootThemeScopeState =
  { known: false } | { known: true; scopeId: string | undefined };

/**
 * The theme scope owned by the focused full-surface app, as a state:
 *
 * - `{ known: false }` — the surface has not registered its placements yet, so
 *   nobody can say which app owns `:root`. Never folded into "no app": the
 *   server already painted the first frame for the app the page opens, and a
 *   reader that guessed the desktop here would repaint over it (the website's
 *   first-paint theme flash). Readers hold what is on screen instead.
 * - `{ known: true, scopeId }` — `app:<id>` when the surface mode is
 *   `themeScope:"app"` (`docked` full-area or `solo` fullscreen) AND an app is
 *   active; `undefined` when no single app fills the surface (desktop /
 *   floating focus → global `:root`).
 *
 * It decides the `:root` token values, via theme-engine's `ThemeInjector`, so
 * the base layer carries the focused full-surface app's theme (the "base layer
 * owns `:root`" model), and the document's light/dark. The app chrome (rail,
 * tab bar, toaster) does NOT wear this: it wears its own fixed theme
 * (`apps-core/chrome-theme`), the same whichever app is focused.
 *
 * Provider-free, so it works outside `<TabsProvider>` (the `Core.Root`
 * `ThemeInjector`): `useActiveApp` resolves the focused app from the URL when
 * called outside a surface — reactive across focus switches, which mirror the
 * focused tab's route into the URL — and `useSurfaceMode` reads the
 * module-level surface-mode store. All THREE inputs are subscribed, including
 * the placement set, which the surface body fills in an effect after the
 * first commit.
 */
export function useRootThemeScopeState(): RootThemeScopeState {
  const activeApp = useActiveApp();
  const mode = useSurfaceMode();
  const placements = usePlacementCapabilities();
  if (placements === null) return { known: false };
  return {
    known: true,
    scopeId:
      placementHasAppThemeScope(placements, mode) && activeApp
        ? appThemeScope(activeApp.id)
        : undefined,
  };
}
