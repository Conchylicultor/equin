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
  fixedThemeScope,
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

/** One sub-theme fragment's sparse block: the tokens it names plus the same group's tokens derived from them. */
export function renderSubThemeBlock(
  group: TokenGroupSpec,
  fragment: TokenGroupFragment,
  subTheme: SubTheme,
): string {
  return renderGroupBlock(
    group,
    subThemeBlockValues(group, definedValues(fragment.light), "light"),
    subThemeBlockValues(group, definedValues(fragment.dark), "dark"),
    themeScopeSelectors(subThemeScope(subTheme)),
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

/** Everything painting depends on that is not a scope's choice. */
export interface ThemePaintSources {
  groups: readonly TokenGroupSpec[];
  /** Code themes and every stored theme, by id. */
  themesById: ReadonlyMap<ThemeId, Theme>;
  subThemes: readonly SubTheme[];
  fixedThemes: readonly FixedTheme[];
}

/** What the screen shows: the theme `:root` wears and every other app with a theme of its own. */
export interface ThemePaintSelection {
  /** The theme the `:root` / `.dark` blocks paint — the focused app's, or the desktop's. */
  rootThemeId: ThemeId;
  /** Each app with its own theme document that does NOT own `:root`, painted on `[data-theme-scope="app:<id>"]`. */
  appThemes: readonly { appId: string; themeId: ThemeId }[];
}

/**
 * Every `<style>` the browser's painter mounts for this selection, as
 * `styleId → css`, in the order it mounts them: the `:root` blocks, each other
 * app's scoped blocks, the sub-themes', the fixed themes'. A selection naming
 * a theme that does not exist paints Default, as the browser does (which also
 * reports it — this function only paints).
 */
export function paintThemeStyles(
  sources: ThemePaintSources,
  selection: ThemePaintSelection,
): Record<string, string> {
  const { groups, themesById } = sources;
  const styles: Record<string, string> = {};

  const paintScope = (themeId: ThemeId, scopeToken?: string) => {
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
  };

  paintScope(selection.rootThemeId);
  for (const { appId, themeId } of selection.appThemes) {
    paintScope(themeId, appThemeScope(appId));
  }

  for (const { subTheme, group, fragment } of subThemeBlocks(
    sources.subThemes,
    groups,
  ).blocks) {
    styles[themeStyleId(group.id, subThemeScope(subTheme))] =
      renderSubThemeBlock(group, fragment, subTheme);
  }

  assertUniqueFixedThemes(sources.fixedThemes);
  for (const fixed of sources.fixedThemes) {
    const { values, colorAdjust } = fixedThemeGroupValues(fixed, groups);
    const scopeToken = fixedThemeScope(fixed);
    for (const g of groups) {
      styles[themeStyleId(g.id, scopeToken)] = renderThemeGroupBlock(
        g,
        values[g.id]!,
        colorAdjust,
        scopeToken,
      );
    }
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
