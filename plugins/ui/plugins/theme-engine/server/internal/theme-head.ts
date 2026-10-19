import { isAppThemeScope } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import {
  paintThemeStyles,
  type ThemeId,
  type ThemePaintSources,
} from "../../core";

/** The theme choices the server reads from config, already resolved per scope. */
export interface ThemeHeadSelections {
  /** The desktop's theme (the base document). */
  baseThemeId: ThemeId;
  /** The configured light/dark setting of the scope that owns it. */
  colorMode: "light" | "dark" | "system";
  /** Every app scope (`app:<id>`) with its own theme document, and its theme. */
  scopes: readonly { scopeId: string; themeId: ThemeId }[];
}

/**
 * The first frame's theme, as head HTML per app path — what theme-engine's
 * `DocumentHead.Fragment` answers.
 *
 * One entry per app with its own theme document, keyed by its base path, whose
 * `:root` wears that app's theme (the browser roots the focused app's theme in
 * the solo / docked surface a page load opens), plus the `""` entry for every
 * other path, rooted on the desktop's theme. Every entry also carries each
 * other such app's scoped blocks, the sub-themes' and the fixed themes' — the
 * same elements the browser mounts, so it adopts them unchanged. An app
 * without a document of its own wears the desktop's theme whole, which is the
 * `""` entry exactly, so it needs none.
 *
 * Each entry ends with the `.dark` class, from the setting rather than its
 * resolution: `system` is resolved against the OS by the page itself.
 */
export function renderThemeHead(
  sources: ThemePaintSources,
  apps: readonly { id: string; basePath: string }[],
  selections: ThemeHeadSelections,
): Record<string, string> {
  const basePathOf = new Map(apps.map((a) => [a.id, a.basePath]));
  // An app scope whose app this composition does not bundle paints nowhere.
  const appThemes = selections.scopes.flatMap(({ scopeId, themeId }) => {
    if (!isAppThemeScope(scopeId)) return [];
    const appId = scopeId.slice(scopeId.indexOf(":") + 1);
    const basePath = basePathOf.get(appId);
    return basePath === undefined ? [] : [{ appId, basePath, themeId }];
  });
  const darkClass = colorModeScript(selections.colorMode);

  const entry = (rootThemeId: ThemeId, rootAppId?: string) =>
    styleTags(
      paintThemeStyles(sources, {
        rootThemeId,
        appThemes: appThemes.filter((a) => a.appId !== rootAppId),
      }),
    ) + darkClass;

  const head: Record<string, string> = { "": entry(selections.baseThemeId) };
  for (const app of appThemes) {
    head[app.basePath] = entry(app.themeId, app.appId);
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

function colorModeScript(mode: ThemeHeadSelections["colorMode"]): string {
  const dark =
    mode === "system"
      ? 'matchMedia("(prefers-color-scheme: dark)").matches'
      : String(mode === "dark");
  return `<script>document.documentElement.classList.toggle("dark",${dark})</script>`;
}
