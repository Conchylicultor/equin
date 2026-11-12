import {
  COLOR_SCHEME_ATTR,
  isAppThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  themePainter,
  type ConfiguredColorMode,
  type ThemeId,
  type ThemePaintSources,
} from "../../core";

/** The theme choices the server reads from config, already resolved per scope. */
export interface ThemeHeadSelections {
  /** The desktop's theme (the base document). */
  baseThemeId: ThemeId;
  /** The global light/dark setting — what `<html>` wears on every path. */
  colorMode: ConfiguredColorMode;
  /** Every app scope (`app:<id>`) with its own theme document, and its theme. */
  scopes: readonly { scopeId: string; themeId: ThemeId }[];
}

/** One app the composition bundles: where a page opens it, and its effective scheme. */
export interface ThemeHeadApp {
  id: string;
  /**
   * The base path a page load opens the app at, full-surface; absent for a
   * surface-mode app (the desktop), whose base path is a route prefix in front
   * of another app's URL — its pages are the `""` entry. Its scoped blocks are
   * painted on the `""` entry: the desktop's chrome wears `app:desktop`.
   */
  basePath?: string;
  /** `effectiveColorMode` of the app (its declared default and the user's override). */
  colorMode: ConfiguredColorMode;
}

/**
 * The first frame's theme, as head HTML per app path — what theme-engine's
 * `DocumentHead.Fragment` answers.
 *
 * A page's head carries what the page shows before the browser's painter has
 * run, and what stays up while it is held. Before React's first commit the body is
 * empty: the only thing on screen is the canvas. In that first commit the
 * browser's `ThemeInjector` paints every block it mounts — in insertion
 * effects, before any layout or paint — from inputs the boot snapshot hydrated
 * (the selections, the saved themes) or code (sub-themes, fixed themes). So
 * the head need not carry every app's blocks (it did: 19 scopes × 19 groups,
 * ~850 KB of CSS on every page load). It carries:
 *
 * - `:root` in the desktop's theme (never re-rooted on an app — see
 *   `ThemePaintSelection`), the base every region inherits;
 * - the canvas — `<body>`'s background, in the theme and scheme of the app the
 *   page opens;
 * - that app's own scoped blocks, when it has a theme document — what the
 *   page's app wears should its theme still be pending at the first commit (a
 *   resident theme source not hydrated while the selections are: the
 *   painter then leaves the served CSS up — a boot snapshot that failed whole
 *   leaves app membership unknown, so no app block is claimed at all). On
 *   the `""` entry these are the themed surface-mode apps' (the desktop), whose
 *   chrome a page outside every tab app's base path shows;
 * - the script putting the desktop's scheme on `<html>` (`system` as a
 *   `matchMedia` test). `<html>`'s scheme is the desktop's on every path: an
 *   app wears its own on its own boundary, so the page never flips it.
 *
 * Every other app's blocks, and the sub-themes' and fixed themes', are the
 * browser's alone; it adopts the served elements by id, so they are never
 * painted twice.
 *
 * One entry per page-opened app whose head differs from the `""` entry's — its
 * own theme document, or a scheme other than the global one — keyed by its
 * base path, plus the `""` entry for every other path. Schemes come from the
 * setting rather than its resolution: `system` is resolved against the OS by
 * the page itself (a `matchMedia` test, a `prefers-color-scheme` query).
 */
export function renderThemeHead(
  sources: ThemePaintSources,
  apps: readonly ThemeHeadApp[],
  selections: ThemeHeadSelections,
): Record<string, string> {
  const themeOf = new Map<string, ThemeId>();
  for (const { scopeId, themeId } of selections.scopes) {
    if (!isAppThemeScope(scopeId)) continue;
    themeOf.set(scopeId.slice(scopeId.indexOf(":") + 1), themeId);
  }
  // An app scope whose app this composition does not bundle paints nowhere.
  const appThemesOf = (opened: readonly ThemeHeadApp[]) =>
    opened.flatMap((app) => {
      const themeId = themeOf.get(app.id);
      return themeId === undefined ? [] : [{ appId: app.id, themeId }];
    });

  // One painter for every entry: they share the `:root` blocks, rendered once
  // here instead of per entry.
  const painter = themePainter(sources);
  const entry = (
    opened: readonly ThemeHeadApp[],
    canvasThemeId: ThemeId,
    colorMode: ConfiguredColorMode,
  ) =>
    styleTags(
      painter.paint({
        baseThemeId: selections.baseThemeId,
        appThemes: appThemesOf(opened),
        canvasThemeId,
        canvasColorMode: colorMode,
      }),
    ) + colorSchemeScript(selections.colorMode);

  const head: Record<string, string> = {
    "": entry(
      apps.filter((app) => app.basePath === undefined),
      selections.baseThemeId,
      selections.colorMode,
    ),
  };
  for (const app of apps) {
    if (app.basePath === undefined) continue;
    const themeId = themeOf.get(app.id);
    if (themeId === undefined && app.colorMode === selections.colorMode) {
      continue;
    }
    head[app.basePath] = entry(
      [app],
      themeId ?? selections.baseThemeId,
      app.colorMode,
    );
  }
  return head;
}

function styleTags(styles: Record<string, string>): string {
  return Object.entries(styles)
    .map(([id, css]) => `<style id="${id}">${escapeStyleText(css)}</style>`)
    .join("");
}

/**
 * A `<style>` element's text ends at the first `</style`, so a stored theme's
 * value (user data — a tweakcn import) must not be able to close it. `\3c ` is
 * CSS's own escape for `<`: the declared value is unchanged.
 */
function escapeStyleText(css: string): string {
  return css.replaceAll("<", "\\3c ");
}

/** `<html>`'s scheme: the desktop's (the global setting). */
function colorSchemeScript(mode: ConfiguredColorMode): string {
  const scheme =
    mode === "system"
      ? 'matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"'
      : JSON.stringify(mode);
  return `<script>document.documentElement.setAttribute("${COLOR_SCHEME_ATTR}",${scheme})</script>`;
}
