import type { TokenGroupSpec, TokenGroupFragment } from "./define-token-group";
import { mergeGroupValues } from "./merge-group-values";
import {
  NEUTRAL_COLOR_ADJUSTMENT,
  type ColorAdjustment,
  type Theme,
  type ThemeId,
} from "./theme";

/** One token group's values in both color modes — complete: every schema key present. */
export interface GroupValues {
  light: Record<string, string>;
  dark: Record<string, string>;
}

/** What a theme paints: every registered group, complete in both modes, plus its color adjustment. */
export interface ResolvedTheme {
  groups: Record<string, GroupValues>;
  colorAdjust: ColorAdjustment;
}

/**
 * Persisted data the resolver could not apply and left out. Stored themes
 * outlive the code that reads them — a token group can be deleted, a token
 * renamed — so this is expected over time, but it is never silent: the caller
 * reports each entry.
 */
export type SkippedThemeValue =
  | { reason: "unregistered-group"; themeId: ThemeId; groupId: string }
  | {
      reason: "unknown-tokens";
      themeId: ThemeId;
      groupId: string;
      tokens: string[];
    };

export interface ThemeResolution {
  theme: ResolvedTheme;
  skipped: SkippedThemeValue[];
}

/**
 * Resolve theme `id` into the values it paints.
 *
 * Every registered group starts at its schema defaults; then the `extends`
 * chain is applied root → leaf, so the leaf wins. Only non-empty values count
 * (`mergeGroupValues`), so an empty string never blanks an inherited token.
 * `colorAdjust` is the leaf's if set, else the nearest ancestor's, else neutral.
 *
 * Throws on an unknown `id`, a missing `extends` target, or an `extends` cycle.
 * The saved-themes endpoints refuse to write any of those, so a throw here is a
 * bug, not bad user data. A fragment for an unregistered group, or token keys
 * the group's schema does not declare, are skipped and returned in `skipped`.
 */
export function resolveTheme(
  id: ThemeId,
  themesById: ReadonlyMap<ThemeId, Theme>,
  groups: readonly TokenGroupSpec[],
): ThemeResolution {
  const chain = extendsChain(id, themesById);
  const groupsById = indexGroups(groups);

  const values: Record<string, GroupValues> = {};
  for (const group of groups) {
    values[group.id] = mergeGroupValues(
      group.schema,
      { light: {}, dark: {} },
      {},
    );
  }

  const skipped: SkippedThemeValue[] = [];
  for (const theme of chain) {
    for (const fragment of theme.fragments) {
      const group = groupsById.get(fragment.groupId);
      if (!group) {
        skipped.push({
          reason: "unregistered-group",
          themeId: theme.id,
          groupId: fragment.groupId,
        });
        continue;
      }
      const { known, unknownTokens } = splitBySchema(group, fragment);
      if (unknownTokens.length > 0) {
        skipped.push({
          reason: "unknown-tokens",
          themeId: theme.id,
          groupId: group.id,
          tokens: unknownTokens,
        });
      }
      values[group.id] = mergeGroupValues(
        group.schema,
        values[group.id]!,
        known,
      );
    }
  }

  const colorAdjust =
    chain.findLast((theme) => theme.colorAdjust !== undefined)?.colorAdjust ??
    NEUTRAL_COLOR_ADJUSTMENT;

  return { theme: { groups: values, colorAdjust }, skipped };
}

/** `id` and its ancestors, root first. */
function extendsChain(
  id: ThemeId,
  themesById: ReadonlyMap<ThemeId, Theme>,
): Theme[] {
  const leafFirst: Theme[] = [];
  const seen = new Set<ThemeId>();
  let current: ThemeId | undefined = id;
  while (current !== undefined) {
    if (seen.has(current)) {
      throw new Error(
        `resolveTheme: theme "${id}" has an extends cycle: ${[...seen, current].join(" → ")}`,
      );
    }
    const theme = themesById.get(current);
    if (!theme) {
      const child = leafFirst.at(-1);
      throw new Error(
        child
          ? `resolveTheme: theme "${child.id}" extends "${current}", which is not a registered theme`
          : `resolveTheme: theme "${id}" is not a registered theme`,
      );
    }
    seen.add(current);
    leafFirst.push(theme);
    current = theme.extends;
  }
  return leafFirst.reverse();
}

function indexGroups(
  groups: readonly TokenGroupSpec[],
): Map<string, TokenGroupSpec> {
  const byId = new Map<string, TokenGroupSpec>();
  for (const group of groups) {
    if (byId.has(group.id)) {
      throw new Error(
        `resolveTheme: token group "${group.id}" is registered twice`,
      );
    }
    byId.set(group.id, group);
  }
  return byId;
}

/** The fragment's values for tokens the group declares, and the names of those it does not. */
function splitBySchema(
  group: TokenGroupSpec,
  fragment: TokenGroupFragment,
): {
  known: { light: Record<string, string>; dark: Record<string, string> };
  unknownTokens: string[];
} {
  const unknown = new Set<string>();
  const keep = (values: TokenGroupFragment["light"]) => {
    const out: Record<string, string> = {};
    for (const [token, value] of Object.entries(values)) {
      if (!Object.hasOwn(group.schema, token)) unknown.add(token);
      else if (value !== undefined) out[token] = value;
    }
    return out;
  };
  const known = { light: keep(fragment.light), dark: keep(fragment.dark) };
  return { known, unknownTokens: [...unknown] };
}
