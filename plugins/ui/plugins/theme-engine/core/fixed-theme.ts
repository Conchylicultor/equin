import type { TokenGroupSpec, TokenGroupFragment } from "./define-token-group";
import { resolveTheme, type ThemeResolution } from "./resolve-theme";
import { duplicateGroupId, type ColorAdjustment, type Theme } from "./theme";

/**
 * A fixed theme: a whole theme that one region of the screen always wears,
 * whatever theme its scope selects — the app chrome's neutral graphite, which
 * stays the same while the focused app changes underneath it.
 *
 * It sits between a `Theme` and a `SubTheme`:
 *  - Like a theme, it is resolved over EVERY token group's schema defaults, so
 *    a token it does not name reads the default, never the surrounding app's
 *    value. Nothing leaks in from the app it hosts.
 *  - Like a sub-theme, it is never selected for a scope: a region opts in with
 *    `<Theme name={fixedThemeScope(fixedTheme)}>`, and the theme picker never
 *    lists it.
 *  - Popups opened from inside wear it too (the portal forward is not
 *    region-only): a menu opened from the chrome is more of the chrome.
 *
 * It paints ONE color scheme in both modes. A fixed theme is constant, so the
 * light/dark switch does not change it: `scheme: "dark"` paints the dark half of
 * the resolution — its fragments' `dark` values over the groups' `darkDefault`s
 * — under both the light and the dark selector. Write fragments with `both(…)`
 * so the two halves cannot disagree about what the theme means.
 *
 * Tailwind's `dark:` variants still follow the page's global light/dark class
 * (per-scope color mode is deferred), so inside a dark fixed theme on a light
 * page those variants stay off; everything painted from tokens is correct.
 */
export interface FixedTheme {
  /** The discriminant `fixedThemeScope` requires, so only a declared fixed theme mints a token. */
  kind: "fixed-theme";
  id: string;
  label: string;
  /** Which half of the resolution is painted, in both modes. */
  scheme: "light" | "dark";
  /** Sparse: at most one per group. */
  fragments: TokenGroupFragment[];
  colorAdjust?: ColorAdjustment;
}

/** Kebab-case: the id lands in a CSS attribute selector and a `<style>` id. */
const FIXED_THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Declare a fixed theme, contributed through `ThemeEngine.FixedTheme`. */
export function defineFixedTheme(def: {
  id: string;
  label: string;
  scheme: "light" | "dark";
  fragments: TokenGroupFragment[];
  colorAdjust?: ColorAdjustment;
}): FixedTheme {
  if (!FIXED_THEME_ID.test(def.id)) {
    throw new Error(
      `defineFixedTheme: id "${def.id}" must be kebab-case (lowercase letters, digits and single dashes).`,
    );
  }
  const dup = duplicateGroupId(def.fragments);
  if (dup !== undefined) {
    throw new Error(
      `defineFixedTheme("${def.id}"): two fragments for token group "${dup}" — a fixed theme has at most one per group.`,
    );
  }
  return { ...def, kind: "fixed-theme" };
}

/**
 * Resolve a fixed theme over `groups`, the same way a selected theme resolves:
 * schema defaults first, then the theme's fragments. A fixed theme extends
 * nothing, so it resolves against itself alone and is never pending.
 */
export function resolveFixedTheme(
  fixed: FixedTheme,
  groups: readonly TokenGroupSpec[],
): ThemeResolution {
  const theme: Theme = {
    id: fixed.id,
    label: fixed.label,
    source: "built-in",
    fragments: fixed.fragments,
    colorAdjust: fixed.colorAdjust,
  };
  return resolveTheme(fixed.id, new Map([[fixed.id, theme]]), groups);
}
