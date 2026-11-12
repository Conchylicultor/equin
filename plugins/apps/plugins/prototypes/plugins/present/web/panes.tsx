import { Pane } from "@plugins/primitives/plugins/pane/web";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { usePrototypeTitle } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PresentPage } from "./components/present-page";
import { prototypePresentRoute } from "./internal/routes";

/**
 * One frame presented as a page of its own: what a frame's Open in a new tab
 * opens, chromeless (`?embed=1`). It draws the same stage as the full-screen
 * presentation, options pill and size chip included.
 *
 * A root route, not a child of the gallery: opened alone it is the only column,
 * so it fills the surface. Its tab is named by the prototype's own `<title>`
 * (a window or tab showing one frame reads as the app it mocks).
 */
export const prototypePresentPane = Pane.define({
  route: prototypePresentRoute,
  app: prototypesApp,
  useResolve: false,
  component: PresentPage,
  title: {
    useText: usePrototypeTitle,
    fallback: (params) => params.name,
  },
});
