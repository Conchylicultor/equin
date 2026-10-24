import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/**
 * Home's routes, declared beside `homeApp` rather than in the plugins that
 * mount a pane on them: the New app pane (`new-app`) names the launcher's
 * route as its parent, and the shell must not depend on it.
 */

/** The launcher — bare `/home`. */
export const homeRootRoute = defineRoute({ id: "home-root", segment: "" });

/** The New app screen — `/home/new`. */
export const newAppRoute = defineRoute({
  id: "home-new-app",
  segment: "new",
  parent: homeRootRoute,
});
