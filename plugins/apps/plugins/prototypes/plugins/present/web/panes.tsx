import { Pane } from "@plugins/primitives/plugins/pane/web";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { PresentPage } from "./components/present-page";
import { PresentCanvasPage } from "./components/present-canvas-page";
import {
  prototypePresentCanvasRoute,
  prototypePresentRoute,
} from "./internal/routes";

/**
 * One frame presented as a page of its own: what the Present menu's
 * new-browser-tab icon opens, chromeless (`?embed=1`). It draws the same stage as the in-app
 * presentations, options pill and size chip included.
 *
 * A root route, not a child of the gallery: opened alone it is the only column,
 * so it fills the surface.
 */
export const prototypePresentPane = Pane.define({
  route: prototypePresentRoute,
  app: prototypesApp,
  useResolve: false,
  component: PresentPage,
  width: 720,
});

/**
 * The canvas as a page of its own: what "Open the canvas in a new tab" opens,
 * chromeless (`?embed=1`), so every frame gets the whole browser tab to compare
 * in. A root route, like the one-frame page, so opened alone it fills the
 * surface.
 */
export const prototypePresentCanvasPane = Pane.define({
  route: prototypePresentCanvasRoute,
  app: prototypesApp,
  useResolve: false,
  component: PresentCanvasPage,
  width: 720,
});
