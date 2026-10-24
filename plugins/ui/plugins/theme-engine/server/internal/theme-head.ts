import { isAppThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  paintThemeStyles,
  type ConfiguredColorMode,
  type ThemeId,
  type ThemePaintSources,
} from "../../core";

/** The theme choices the server reads from config, already resolved per scope. */
export interface ThemeHeadSelections {
  /** The desktop's theme (the base document). */
  baseThemeId: ThemeId;
  /** The global light/dark setting — what a path no app owns wears. */
  colorMode: ConfiguredColorMode;
  /** Every app scope (`app:<id>`) with its own theme document, and its theme. */
  scopes: readonly { scopeId: string; themeId: ThemeId }[];
}

/** One app the composition bundles: where it is mounted, and its effective scheme. */
export interface ThemeHeadApp {
  id: string;
  basePath: string;
  /** `effectiveColorMode` of the app (its declared default and the user's override). */
  colorMode: ConfiguredColorMode;
}

/**
 * The first frame's theme, as head HTML per app path — what theme-engine's
 * `DocumentHead.Fragment` answers.
 *
 * One entry per app that differs from the desktop, keyed by its base path: an
 * app with its own theme document, whose `:root` wears that app's theme (the
 * browser roots the focused app's theme in the solo / docked surface a page
 * load opens), or one whose colour scheme is not the global one. Plus the `""`
 * entry for every other path, rooted on the desktop's theme in the global
 * scheme. Every entry also carries each other themed app's scoped blocks, the
 * sub-themes' and the fixed themes' — the same elements the browser mounts, so
 * it adopts them unchanged. An app like the desktop in both is the `""` entry
 * exactly, so it needs none.
 *
 * Each entry ends with the `.dark` class of the app it is rooted on, from the
 * setting rather than its resolution: `system` is resolved against the OS by
 * the page itself.
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
    return themeId === undefined
      ? []
      : [{ appId: app.id, basePath: app.basePath, themeId }];
  });

  const entry = (
    rootThemeId: ThemeId,
    colorMode: ConfiguredColorMode,
    rootAppId?: string,
  ) =>
    styleTags(
      paintThemeStyles(sources, {
        rootThemeId,
        appThemes: appThemes.filter((a) => a.appId !== rootAppId),
      }),
    ) + colorModeScript(colorMode);

  const head: Record<string, string> = {
    "": entry(selections.baseThemeId, selections.colorMode),
  };
  for (const app of apps) {
    const themeId = themeOf.get(app.id);
    if (themeId === undefined && app.colorMode === selections.colorMode) {
      continue;
    }
    head[app.basePath] = entry(
      themeId ?? selections.baseThemeId,
      app.colorMode,
      themeId === undefined ? undefined : app.id,
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

function colorModeScript(mode: ConfiguredColorMode): string {
  const dark =
    mode === "system"
      ? 'matchMedia("(prefers-color-scheme: dark)").matches'
      : String(mode === "dark");
  return `<script>document.documentElement.classList.toggle("dark",${dark})</script>`;
}
