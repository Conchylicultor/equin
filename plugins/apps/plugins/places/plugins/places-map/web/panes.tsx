import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { placesApp } from "@plugins/apps/plugins/places/plugins/shell/core";
import { PlacesScreen } from "./components/places-screen";

/**
 * The Places app's index pane — what bare `/places` shows. No pane header: the
 * map fills the whole surface, and the app launcher sits at the head of the
 * floating tag sidebar instead.
 */
export const placesMapPane = Pane.define({
  title: placesApp.name,
  route: defineRoute({ id: "places-map", segment: "" }),
  app: placesApp,
  appIndex: true,
  component: PlacesScreen,
});
