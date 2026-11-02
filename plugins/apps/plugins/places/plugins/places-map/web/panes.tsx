import { Pane } from "@plugins/primitives/plugins/pane/web";
import { placesApp } from "@plugins/apps/plugins/places/plugins/shell/core";
import { placesMapRoute } from "@plugins/apps/plugins/places/plugins/page-overlay/core";
import { PlacesScreen } from "./components/places-screen";

/**
 * The Places app's index pane — what bare `/places` shows. No pane header: the
 * map fills the whole surface, and the app launcher sits at the head of the
 * floating tag sidebar instead. Its `;page` param lays one page's places over
 * the map (`/places;page=<pageId>`, page-overlay) — a view of this same
 * mounted pane, so opening and closing it never remounts the map.
 */
export const placesMapPane = Pane.define({
  title: placesApp.name,
  route: placesMapRoute,
  app: placesApp,
  appIndex: true,
  component: PlacesMapBody,
});

function PlacesMapBody() {
  const { page } = placesMapPane.useParams();
  const setParams = placesMapPane.useSetParams();
  return (
    <PlacesScreen
      pageId={page ?? null}
      onClosePage={() => setParams({ page: undefined })}
    />
  );
}
