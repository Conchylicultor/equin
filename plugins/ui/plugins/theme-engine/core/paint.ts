// Turning resolved themes into the CSS text of the `<style>` elements that paint
// them. ONE implementation, run by two painters: the browser's ThemeInjector
// (live, per React commit) and the server, which renders the same elements
// into the HTML of the first frame (theme-engine/server's document head). The
// browser adopts the server's elements by id and rewrites only what differs, so
// the two must agree byte for byte — which is why every block goes through the
// functions below and neither painter spells a selector, a style id or a
// serialization of its own.

import {
  appThemeScope,
  subThemeScope,
  themeScopeSelectors,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type {
  TokenGroupFragment,
  TokenGroupSpec,
  TokenValues,
} from "./define-token-group";
import { resolveFixedTheme, type FixedTheme } from "./fixed-theme";
import {
  resolveTheme,
  type GroupValues,
  type ResolvedTheme,
  type SkippedThemeValue,
} from "./resolve-theme";
import { renderGroupBlock } from "./serialize-vars";
import { subThemeBlockValues, type SubTheme } from "./sub-theme";
import {
  DEFAULT_THEME_ID,
  type ColorAdjustment,
  type Theme,
  type ThemeId,
} from "./theme";
import { transformValues } from "./transform";
import type { ConfiguredColorMode } from "./config";

/**
 * The `<style>` id a token group's block is painted under: `theme-engine-<group>`
 * for the `:root` / `.dark` block, `theme-scope-<token>-<group>` for a block
 * scoped to `[data-theme-scope="<token>"]` (an app's, a sub-theme's, a fixed
 * theme's). The id is how the browser adopts an element the server painted.
 */
export function themeStyleId(groupId: string, scopeToken?: string): string {
  return scopeToken === undefined
    ? `theme-engine-${groupId}`
    : `theme-scope-${scopeToken}-${groupId}`;
}

/** Every painted `<style>` id starts with one of these — what a prune of stale elements matches. */
export const THEME_STYLE_ID_PREFIXES = ["theme-engine-", "theme-scope-"];

/**
 * Loud completeness backstop: every declared token var must resolve in both
 * modes. With schema defaults as the resolver's base this never fires for a
 * sparse theme (by construction) — it catches developer bugs: an empty schema
 * `default`.
 */
function assertComplete(
  group: TokenGroupSpec,
  light: Record<string, string>,
  dark: Record<string, string>,
): void {
  const keys = Object.keys(group.schema);
  const missingIn = (values: Record<string, string>) =>
    keys.filter((k) => values[k] === undefined || values[k] === "");
  const missingLight = missingIn(light);
  const missingDark = missingIn(dark);
  if (missingLight.length === 0 && missingDark.length === 0) return;
  const parts: string[] = [];
  if (missingLight.length) parts.push(`light: ${missingLight.join(", ")}`);
  if (missingDark.length) parts.push(`dark: ${missingDark.join(", ")}`);
  throw new Error(
    `Token group "${group.id}" produced incomplete values after merge — ` +
      `missing/empty schema keys (${parts.join("; ")}). Every declared token ` +
      `must resolve in both modes; check the group's schema defaults.`,
  );
}

/**
 * One token group's block for a resolved (selected or fixed) theme: complete in
 * both modes, color-adjusted, on `:root` / `.dark` or — given `scopeToken` — on
 * that scope's selector pair.
 */
export function renderThemeGroupBlock(
  group: TokenGroupSpec,
  values: GroupValues,
  colorAdjust: ColorAdjustment,
  scopeToken?: string,
): string {
  assertComplete(group, values.light, values.dark);
  return renderGroupBlock(
    group,
    transformValues(values.light, colorAdjust),
    transformValues(values.dark, colorAdjust),
    scopeToken === undefined ? undefined : themeScopeSelectors(scopeToken),
  );
}

/**
 * One sub-theme fragment's sparse block: the tokens it names plus the same
 * group's tokens derived from them — on the sub-theme's selector, or on
 * `scopeToken` (the sub-theme's token qualified by a plugin scope).
 */
export function renderSubThemeBlock(
  group: TokenGroupSpec,
  fragment: TokenGroupFragment,
  subTheme: SubTheme,
  scopeToken: string = subThemeScope(subTheme),
): string {
  return renderGroupBlock(
    group,
    subThemeBlockValues(group, definedValues(fragment.light), "light"),
    subThemeBlockValues(group, definedValues(fragment.dark), "dark"),
    themeScopeSelectors(scopeToken),
  );
}

/**
 * The blocks every contributed sub-theme paints — one per fragment whose group
 * is registered — and what could not be painted as written. Throws on two
 * sub-themes claiming one id.
 */
export function subThemeBlocks(
  subThemes: readonly SubTheme[],
  groups: readonly TokenGroupSpec[],
): {
  blocks: {
    subTheme: SubTheme;
    group: TokenGroupSpec;
    fragment: TokenGroupFragment;
  }[];
  skipped: SkippedThemeValue[];
} {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const skipped: SkippedThemeValue[] = [];
  const blocks: {
    subTheme: SubTheme;
    group: TokenGroupSpec;
    fragment: TokenGroupFragment;
  }[] = [];
  for (const subTheme of subThemes) {
    if (seen.has(subTheme.id)) {
      throw new Error(
        `[theme-engine] two sub-themes claim the id "${subTheme.id}" — sub-theme ids must be unique.`,
      );
    }
    seen.add(subTheme.id);
    for (const fragment of subTheme.fragments) {
      const group = groupsById.get(fragment.groupId);
      if (!group) {
        skipped.push({
          reason: "unregistered-group",
          themeId: subTheme.id,
          groupId: fragment.groupId,
        });
        continue;
      }
      const unknown = Object.keys(fragment.light).filter(
        (token) => !Object.hasOwn(group.schema, token),
      );
      if (unknown.length > 0) {
        skipped.push({
          reason: "unknown-tokens",
          themeId: subTheme.id,
          groupId: group.id,
          tokens: unknown,
        });
      }
      blocks.push({ subTheme, group, fragment });
    }
  }
  return { blocks, skipped };
}

/** Throws on two fixed themes claiming one id. */
export function assertUniqueFixedThemes(
  fixedThemes: readonly FixedTheme[],
): void {
  const seen = new Set<string>();
  for (const fixed of fixedThemes) {
    if (seen.has(fixed.id)) {
      throw new Error(
        `[theme-engine] two fixed themes claim the id "${fixed.id}" — fixed theme ids must be unique.`,
      );
    }
    seen.add(fixed.id);
  }
}

/**
 * A fixed theme's per-group values: its `scheme` half of the resolution, worn in
 * both modes (the frame does not flip with the light/dark switch).
 */
export function fixedThemeGroupValues(
  fixed: FixedTheme,
  groups: readonly TokenGroupSpec[],
): {
  values: Record<string, GroupValues>;
  colorAdjust: ColorAdjustment;
  skipped: SkippedThemeValue[];
} {
  const { theme, skipped } = resolveFixedTheme(fixed, groups);
  const values: Record<string, GroupValues> = {};
  for (const g of groups) {
    const painted = theme.groups[g.id]![fixed.scheme];
    values[g.id] = { light: painted, dark: painted };
  }
  return { values, colorAdjust: theme.colorAdjust, skipped };
}

/**
 * Everything a scope's painting depends on that is not its choice. Sub-themes
 * and fixed themes are not here: they are code, painted by the browser in its
 * first commit, never pending — so the server has no first frame to paint them
 * for (see {@link themePainter}).
 */
export interface ThemePaintSources {
  groups: readonly TokenGroupSpec[];
  /** Code themes and every stored theme, by id. */
  themesById: ReadonlyMap<ThemeId, Theme>;
}

/**
 * What the screen shows. `:root` wears ONE stable theme — the desktop's — and
 * never follows navigation or the surface mode: a change of inherited custom
 * properties at the root restyles the whole document (~18k elements, 350–480 ms
 * a time in Chromium), which is what switching the surface between the desktop
 * and full screen used to pay. Every app with a theme of its own wears it on its
 * own `[data-theme-scope="app:<id>"]` boundary instead — every tab container is
 * one — painted whether or not it is focused.
 */
export interface ThemePaintSelection {
  /** The theme the `:root` / `.dark` blocks paint: the desktop's (the base document's). */
  baseThemeId: ThemeId;
  /**
   * The apps whose scoped blocks to paint, on `[data-theme-scope="app:<id>"]`
   * — each with its own theme document. The browser paints every themed app;
   * the server's first frame only the one a page load opens (theme-head.ts).
   */
  appThemes: readonly { appId: string; themeId: ThemeId }[];
  /**
   * The theme whose `--background` the document canvas (`<body>`) paints: the
   * app the page shows full-surface, else the desktop's. Only `<body>` reads it
   * — a non-inherited property on one element — so following the focused app
   * costs nothing, unlike re-rooting the tokens.
   */
  canvasThemeId: ThemeId;
  /**
   * The scheme the canvas is painted in: that same app's (`effectiveColorMode`),
   * the desktop's with no app. `<html>` always carries the desktop's scheme, so
   * the canvas cannot read it from there — it is baked into the block
   * (`system` as a `prefers-color-scheme` query).
   */
  canvasColorMode: ConfiguredColorMode;
}

/**
 * The `<style>` elements of a selection, as `styleId → css`, in the order the
 * browser's painter mounts them: the `:root` blocks, each app's scoped blocks,
 * the canvas — the server's first-frame head. A selection naming
 * a theme that does not exist paints Default, as the browser does (which also
 * reports it — this function only paints).
 */
export function paintThemeStyles(
  sources: ThemePaintSources,
  selection: ThemePaintSelection,
): Record<string, string> {
  return themePainter(sources).paint(selection);
}

/** {@link paintThemeStyles} over one set of sources, for several selections. */
export interface ThemePainter {
  paint(selection: ThemePaintSelection): Record<string, string>;
}

/**
 * A painter of several selections over the same sources — the server's
 * first-frame head paints one per app path. A block is a function of the
 * sources and of its (theme, scope) alone, so each is rendered once per
 * painter however many selections hold it (the `:root` blocks every entry
 * holds, an app's blocks for a theme). Holds nothing past the painter: a new
 * render makes a new one.
 *
 * Never the sub-themes' or fixed themes' blocks: those are code, so the
 * browser paints them in the insertion effects of its first commit, before
 * any region wearing them is on screen — and before that commit the page body
 * is empty, so nothing could read them. Inlining them cost every page load
 * ~230 KB of CSS for no frame.
 */
export function themePainter(sources: ThemePaintSources): ThemePainter {
  const scopes = new Map<string, Record<string, string>>();
  const canvases = new Map<string, string>();

  const scope = (themeId: ThemeId, scopeToken?: string) => {
    const key = JSON.stringify([themeId, scopeToken ?? null]);
    let painted = scopes.get(key);
    if (painted === undefined) {
      painted = paintScopeStyles(sources, themeId, scopeToken);
      scopes.set(key, painted);
    }
    return painted;
  };

  return {
    paint(selection) {
      const styles: Record<string, string> = {};
      Object.assign(styles, scope(selection.baseThemeId));
      for (const { appId, themeId } of selection.appThemes) {
        Object.assign(styles, scope(themeId, appThemeScope(appId)));
      }
      const canvasKey = `${selection.canvasThemeId}\u0000${selection.canvasColorMode}`;
      let canvas = canvases.get(canvasKey);
      if (canvas === undefined) {
        canvas = paintCanvasStyle(
          sources,
          selection.canvasThemeId,
          selection.canvasColorMode,
        );
        canvases.set(canvasKey, canvas);
      }
      styles[CANVAS_STYLE_ID] = canvas;
      return styles;
    },
  };
}

/**
 * The `<style>` id of the document canvas — `<body>`'s background, painted from
 * one theme's `--background` (see {@link ThemePaintSelection.canvasThemeId}).
 * Under the `theme-engine-` prefix so the prune keeps it only while claimed; no
 * token group may take the id `canvas` (asserted where it is painted).
 */
export const CANVAS_STYLE_ID = themeStyleId("canvas");

/** The CSS var the canvas paints — the `canvas` surface's own background role. */
const CANVAS_VAR = "--background";

/**
 * The document canvas block: `<body>`'s background in the theme's
 * `--background`, in the scheme `colorMode` names — `system` as both values,
 * switched by a `prefers-color-scheme` query. Written out as values (not
 * `var()`), because `<body>` sits outside every app boundary and reads `:root`'s
 * tokens. A value that is itself a `var()` resolves against `:root` — the
 * desktop's theme, in the desktop's scheme.
 */
export function renderCanvasBlock(
  groups: readonly TokenGroupSpec[],
  theme: ResolvedTheme,
  colorMode: ConfiguredColorMode,
): string {
  if (groups.some((g) => g.id === "canvas")) {
    throw new Error(
      `[theme-engine] a token group claims the id "canvas" — its style id would collide with the document canvas (${CANVAS_STYLE_ID}).`,
    );
  }
  const group = groups.find((g) => Object.values(g.vars).includes(CANVAS_VAR));
  if (group === undefined) {
    throw new Error(
      `[theme-engine] no registered token group declares ${CANVAS_VAR} — the document canvas has nothing to paint.`,
    );
  }
  const key = Object.keys(group.vars).find(
    (k) => group.vars[k] === CANVAS_VAR,
  )!;
  const values = theme.groups[group.id]!;
  const light = transformValues(values.light, theme.colorAdjust)[key];
  const dark = transformValues(values.dark, theme.colorAdjust)[key];
  const body = (value: string | undefined) =>
    `body {\n  background-color: ${value};\n}`;
  if (colorMode === "system") {
    return `${body(light)}\n@media (prefers-color-scheme: dark) {\n${body(dark)}\n}`;
  }
  return body(colorMode === "dark" ? dark : light);
}

function paintCanvasStyle(
  sources: ThemePaintSources,
  themeId: ThemeId,
  colorMode: ConfiguredColorMode,
): string {
  const painted = sources.themesById.has(themeId) ? themeId : DEFAULT_THEME_ID;
  const { theme } = resolveTheme(painted, sources.themesById, sources.groups);
  return renderCanvasBlock(sources.groups, theme, colorMode);
}

/** One scope's blocks — `:root` without a token, else `[data-theme-scope=…]` — for the theme it selects. */
function paintScopeStyles(
  sources: ThemePaintSources,
  themeId: ThemeId,
  scopeToken?: string,
): Record<string, string> {
  const { groups, themesById } = sources;
  const styles: Record<string, string> = {};
  const painted = themesById.has(themeId) ? themeId : DEFAULT_THEME_ID;
  const { theme } = resolveTheme(painted, themesById, groups);
  for (const g of groups) {
    styles[themeStyleId(g.id, scopeToken)] = renderThemeGroupBlock(
      g,
      theme.groups[g.id]!,
      theme.colorAdjust,
      scopeToken,
    );
  }
  return styles;
}

function definedValues(values: TokenValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [token, value] of Object.entries(values)) {
    if (value !== undefined) out[token] = value;
  }
  return out;
}
