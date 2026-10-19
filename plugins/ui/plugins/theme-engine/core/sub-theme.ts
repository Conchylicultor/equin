import type { TokenGroupSpec, TokenGroupFragment } from "./define-token-group";
import { duplicateGroupId } from "./theme";

/**
 * A sub-theme: a few token values that one region of the screen wears ON TOP of
 * the theme around it — the website's page type scale over the site's palette.
 *
 * Unlike a `Theme`, it is never selected for a scope and is never
 * resolved against schema defaults. A region opts in with
 * `<Theme name={subThemeScope(subTheme)}>`, and every token the sub-theme does
 * not name keeps whatever the surrounding theme paints, by plain CSS
 * inheritance. So a sub-theme that only sets sizes follows the app's palette
 * wherever it goes, including after the app's theme is switched.
 *
 * Its values are painted as written: the surrounding theme's color adjustment
 * does not apply to them.
 */
export interface SubTheme {
  /** The discriminant `subThemeScope` requires, so only a declared sub-theme mints a token. */
  kind: "sub-theme";
  id: string;
  label: string;
  /** Sparse: at most one per group; each names the same tokens in light and dark. */
  fragments: TokenGroupFragment[];
}

/** Kebab-case: the id lands in a CSS attribute selector and a `<style>` id. */
const SUB_THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Declare a sub-theme, contributed through `ThemeEngine.SubTheme`. */
export function defineSubTheme(def: {
  id: string;
  label: string;
  fragments: TokenGroupFragment[];
}): SubTheme {
  if (!SUB_THEME_ID.test(def.id)) {
    throw new Error(
      `defineSubTheme: id "${def.id}" must be kebab-case (lowercase letters, digits and single dashes).`,
    );
  }
  const dup = duplicateGroupId(def.fragments);
  if (dup !== undefined) {
    throw new Error(
      `defineSubTheme("${def.id}"): two fragments for token group "${dup}" — a sub-theme has at most one per group.`,
    );
  }
  for (const fragment of def.fragments) {
    assertSameTokensInBothModes(def.id, fragment);
  }
  return { ...def, kind: "sub-theme" };
}

/**
 * A sub-theme's light block also matches in dark mode (the dark block only
 * overrides what it names), so a token set in light alone would leak its light
 * value onto a dark page. Requiring both modes to name the same tokens, each
 * with a real value, rules that out. `both(…)` satisfies it for a mode-free
 * group.
 */
function assertSameTokensInBothModes(
  id: string,
  fragment: TokenGroupFragment,
): void {
  const named = (values: TokenGroupFragment["light"]) =>
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([token, value]) => {
        if (value === "") {
          throw new Error(
            `defineSubTheme("${id}"): token "${token}" of group "${fragment.groupId}" is empty — leave it out to keep the surrounding theme's value.`,
          );
        }
        return token;
      })
      .sort();
  const light = named(fragment.light);
  const dark = named(fragment.dark);
  if (light.join(",") !== dark.join(",")) {
    throw new Error(
      `defineSubTheme("${id}"): group "${fragment.groupId}" names different tokens in light (${light.join(", ")}) and dark (${dark.join(", ")}) — a sub-theme sets each token in both modes.`,
    );
  }
}

/**
 * The values a sub-theme block writes for one group in one mode: the tokens the
 * fragment names, plus every token of the same group whose schema default is
 * DERIVED from one of them (`chromePanePadStart: var(--chrome-pad-x)`), at that
 * default.
 *
 * Why the extra tokens: a custom property's `var()` is substituted where the
 * property is declared, and descendants inherit the result. The surrounding
 * theme declares a derived token at its own scope, so it arrives in the region
 * already computed from the surrounding base — re-valuing only the base would
 * reach nothing derived from it (the website header kept the app's 12px pane
 * inset under a sub-theme that set the gutter). Re-declaring the derived token
 * inside the region recomputes it there. So inside a sub-theme a group's
 * derivations follow the sub-theme's values, even where the surrounding theme
 * had given the derived token a value of its own; to keep a different one, the
 * sub-theme names it.
 *
 * Within one group only: a derivation that crosses groups is not re-declared.
 */
export function subThemeBlockValues(
  group: TokenGroupSpec,
  named: Record<string, string>,
  mode: "light" | "dark",
): Record<string, string> {
  const out = { ...named };
  const tokens = Object.keys(group.schema);
  const defaultOf = (token: string) => {
    const field = group.schema[token]!;
    return mode === "dark"
      ? (field.darkDefault ?? field.default)
      : field.default;
  };
  // A fixpoint: a token derived from a re-declared one is re-declared too.
  let grew = true;
  while (grew) {
    grew = false;
    const changedVars = Object.keys(out).map((token) => group.vars[token]);
    for (const token of tokens) {
      if (Object.hasOwn(out, token)) continue;
      const value = defaultOf(token);
      if (changedVars.some((v) => v !== undefined && readsVar(value, v))) {
        out[token] = value;
        grew = true;
      }
    }
  }
  return out;
}

/** Does a CSS value read the custom property `name` (as `var(name)` or `var(name, …)`)? */
function readsVar(value: string, name: string): boolean {
  return new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(value);
}
