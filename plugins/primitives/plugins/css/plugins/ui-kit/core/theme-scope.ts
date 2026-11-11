/** The `data-theme-scope` token vocabulary. `ui-kit` owns the attribute contract
 *  (the portal forwarding in `web/components/portal-theme-scope.tsx`), so it owns
 *  the token strings too — both producers (theme-engine's painter, in the browser
 *  and on the server that renders the first frame's CSS) and consumers (the
 *  chrome surfaces, the desktop window frames) reference these instead of
 *  duplicating literals. Plain strings, so they live here where every runtime
 *  can read them. */
const APP_PREFIX = "app:";
export const appThemeScope = (appId: string) => `${APP_PREFIX}${appId}`;

/** Whether a scope token names an app's theme (`app:<id>`) — the scope an app's
 *  own settings are read in — rather than a sub-theme or a fixed theme. */
export const isAppThemeScope = (token: string) => token.startsWith(APP_PREFIX);

/** The prefix only {@link subThemeScope} mints. */
const SUB_THEME_PREFIX = "sub:";

/** A sub-theme's token: `sub:<id>`. Takes the declared sub-theme itself (from
 *  theme-engine's `defineSubTheme`), not its id, so a misspelled id has no
 *  spelling. */
export const subThemeScope = (subTheme: { kind: "sub-theme"; id: string }) =>
  `${SUB_THEME_PREFIX}${subTheme.id}`;

/** A fixed theme's token: `fixed:<id>`. Takes the declared fixed theme itself
 *  (from theme-engine's `defineFixedTheme`), not its id, so a misspelled id has
 *  no spelling. A fixed theme is a WHOLE theme a region always wears (the app
 *  chrome), so — unlike a sub-theme — popups opened from inside keep it. */
export const fixedThemeScope = (fixedTheme: {
  kind: "fixed-theme";
  id: string;
}) => `fixed:${fixedTheme.id}`;

/** Whether a scope token names a sub-theme rather than a whole theme. A
 *  sub-theme sets a few tokens over the theme around it; popups opened from
 *  inside it go back to that surrounding theme (see theme-boundary). */
export const isSubThemeScope = (token: string) =>
  token.startsWith(SUB_THEME_PREFIX);

/**
 * Where a scoped token block is painted: the light half on the scope's
 * elements, the dark half on those whose NEAREST scheme carrier (self
 * included) is dark — inside {@link DARK_SCHEME_SCOPE}, never "under a dark
 * `<html>`", so a light app inside a dark desktop takes its light values. Same
 * specificity both halves; the scoped one wins by scope proximity.
 */
export const themeScopeSelectors = (token: string): SchemeSelectors => ({
  light: `[data-theme-scope="${token}"]`,
  dark: `[data-theme-scope="${token}"]${IN_SCOPE}`,
  darkScope: DARK_SCHEME_SCOPE,
});

/**
 * The token a plugin scope's root boundary wears (`DemoScope` draws it): the
 * scope's own base theme, painted by the scope's theme hosts — the scope's
 * `:root`. Only ever written qualified ({@link qualifyThemeScope}).
 */
export const PLUGIN_SCOPE_ROOT_THEME = "root";

/** The separator between a plugin scope's id and the token it qualifies. */
const PLUGIN_SCOPE_SEPARATOR = "/";

/**
 * A theme-scope token as it is written into the DOM and painted: bare on the
 * page (`pluginScope` null), `<plugin scope>/<token>` inside a `<PluginScope>`.
 * Every writer of the attribute (`<Theme>`, the portal forward) and every
 * painter of its selector (theme-engine) goes through this, so a block the
 * PAGE paints (`[data-theme-scope="app:sonata"]`) cannot match an element a
 * scope stamped (`agent-manager-demo/app:sonata`), and a scope's block never
 * matches the page: inside a scope only the scope's own theme hosts paint.
 */
export const qualifyThemeScope = (
  pluginScope: string | null,
  token: string,
): string =>
  pluginScope === null
    ? token
    : `${pluginScope}${PLUGIN_SCOPE_SEPARATOR}${token}`;

/** The bare token of a {@link qualifyThemeScope}d one, for `pluginScope`. */
export const bareThemeScope = (
  pluginScope: string | null,
  qualified: string,
): string => {
  if (pluginScope === null) return qualified;
  const prefix = `${pluginScope}${PLUGIN_SCOPE_SEPARATOR}`;
  if (!qualified.startsWith(prefix)) {
    throw new Error(
      `theme scope "${qualified}" was not qualified by plugin scope "${pluginScope}"`,
    );
  }
  return qualified.slice(prefix.length);
};

// ── Colour schemes ─────────────────────────────────────────────────────────
/**
 * Per-region colour schemes: the attribute a region says "I am light / dark"
 * with, and where every scheme-dependent style is written.
 *
 * A document wears MANY schemes at once: `<html>` carries the desktop's, and
 * every scheme boundary below it (an app's `<Theme>`, a fixed theme's, a popup
 * re-stamped with the scheme of the region it was opened from, a forced-dark
 * region such as the image viewer) carries its own. What an element wears is
 * the NEAREST carrier's scheme — self included — never "is there a dark one
 * anywhere above me", so a light app inside a dark desktop is light all the
 * way down, and a dark window inside that light app is dark again, at any
 * depth.
 *
 * Three things follow the nearest carrier:
 *
 * - `color-scheme` (form controls, scrollbars, `Canvas`, `light-dark()`): an
 *   inherited property, set on each carrier (ui-kit's `app.css`) — nearest
 *   wins by inheritance, nothing to compute.
 * - the theme's token blocks: the desktop's base blocks are declared on every
 *   carrier ({@link ROOT_SCHEME_SELECTORS}), each scoped block's dark half in
 *   {@link DARK_SCHEME_SCOPE} ({@link themeScopeSelectors}).
 * - Tailwind's `dark:` variant (`app.css`'s `@custom-variant dark`), in
 *   {@link DARK_SCHEME_SCOPE}.
 *
 * Because a region's scheme is ITS attribute, focusing another app or
 * switching the surface mode changes no scheme anywhere: nothing restyles but
 * what actually changed scheme.
 */

/** The attribute every scheme carrier stamps — `light` or `dark`. */
export const COLOR_SCHEME_ATTR = "data-color-scheme";

/** A region's resolved colour scheme. */
export type ColorScheme = "light" | "dark";

/**
 * "The nearest carrier is dark", positively: a dark carrier is a scope root and
 * a light one its limit, so an element is in scope exactly when some dark
 * carrier encloses it (or is it) with no light carrier in between — at any
 * nesting depth. (A negated descendant selector would say the same, but a
 * complex `:not()` makes Chrome restyle whole subtrees on unrelated changes —
 * the `negated-complex-selector` check.)
 */
export const DARK_SCHEME_SCOPE = `@scope ([${COLOR_SCHEME_ATTR}="dark"]) to ([${COLOR_SCHEME_ATTR}="light"])`;

/**
 * Inside {@link DARK_SCHEME_SCOPE}: the root itself and everything below it.
 * Written explicitly (a bare selector there means descendants only) and weighing
 * one attribute — so a `dark:` utility keeps the (0,2,0) the old `.dark *`
 * variant had, and a scoped token block's dark half the weight of its light one.
 */
const IN_SCOPE = ":is(:scope, :scope *)";

/** A block's selectors: the light half, and the dark half (inside `darkScope` when set). */
export interface SchemeSelectors {
  light: string;
  dark: string;
  /** The at-rule the dark half is wrapped in, when its selector needs one. */
  darkScope?: string;
}

/** The Tailwind `dark:` variant's body, as `app.css` must declare it. */
export const DARK_VARIANT_CSS = `@custom-variant dark {\n    ${DARK_SCHEME_SCOPE} {\n        &${IN_SCOPE} {\n            @slot;\n        }\n    }\n}`;

/**
 * The selectors the desktop's base theme is painted on: `:root` and every
 * scheme carrier, light half and dark half. A carrier re-declares the base
 * tokens in ITS scheme, so a region whose app has no theme of its own wears
 * the desktop's theme in the region's scheme — not the `<html>` scheme it
 * would otherwise inherit computed. Zero specificity (`:where`), so any
 * scoped block on the same element (an app's own theme, a fixed theme) wins.
 */
export const ROOT_SCHEME_SELECTORS: SchemeSelectors = {
  light: `:where(:root, [${COLOR_SCHEME_ATTR}])`,
  dark: `:where([${COLOR_SCHEME_ATTR}="dark"])`,
};
