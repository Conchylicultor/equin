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

export const themeScopeSelectors = (token: string) => ({
  light: `[data-theme-scope="${token}"]`,
  dark: `.dark [data-theme-scope="${token}"]`,
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
