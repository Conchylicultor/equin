import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { placesApp } from "@plugins/apps/plugins/places/plugins/shell/core";
import { PlacesScreen } from "./components/places-screen";

/**
 * The Places app's index pane — what bare `/places` shows. Its standard pane
 * header, titled with the app's name, is the surface's top chrome (the app
 * shell hands it the launcher); under it the map fills the pane edge to edge.
 */
export const placesMapPane = Pane.define({
  title: placesApp.name,
  route: defineRoute({ id: "places-map", segment: "" }),
  app: placesApp,
  appIndex: true,
  component: PlacesMapPane,
});

function PlacesMapPane() {
  return (
    <PaneChrome pane={placesMapPane}>
      <PlacesScreen />
    </PaneChrome>
  );
}
