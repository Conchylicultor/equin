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
   * painted all the same: the desktop's chrome wears `app:desktop`.
   */
  basePath?: string;
  /** `effectiveColorMode` of the app (its declared default and the user's override). */
  colorMode: ConfiguredColorMode;
}

/**
 * The first frame's theme, as head HTML per app path — what theme-engine's
 * `DocumentHead.Fragment` answers.
 *
 * Every entry carries the SAME token blocks the browser mounts whatever it
 * shows: `:root` in the desktop's theme (never re-rooted on an app — see
 * `ThemePaintSelection`), each themed app's scoped blocks, the sub-themes' and
 * the fixed themes'. So the browser adopts them unchanged on any path. What
 * differs per path is only what the page around the app wears before it
 * mounts: the canvas — `<body>`'s background, in the app's theme and scheme.
 * `<html>`'s scheme (`data-color-scheme`) is the desktop's on every path: an
 * app wears its own on its own boundary, so the page never flips it.
 *
 * One entry per page-opened app whose canvas differs from the desktop's — its
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
  const appThemes = apps.flatMap((app) => {
    const themeId = themeOf.get(app.id);
    return themeId === undefined ? [] : [{ appId: app.id, themeId }];
  });

  // One painter for every entry: they share every token block, rendered once
  // here instead of per entry.
  const painter = themePainter(sources);
  const entry = (canvasThemeId: ThemeId, colorMode: ConfiguredColorMode) =>
    styleTags(
      painter.paint({
        baseThemeId: selections.baseThemeId,
        appThemes,
        canvasThemeId,
        canvasColorMode: colorMode,
      }),
    ) + colorSchemeScript(selections.colorMode);

  const head: Record<string, string> = {
    "": entry(selections.baseThemeId, selections.colorMode),
  };
  for (const app of apps) {
    if (app.basePath === undefined) continue;
    const themeId = themeOf.get(app.id);
    if (themeId === undefined && app.colorMode === selections.colorMode) {
      continue;
    }
    head[app.basePath] = entry(
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
