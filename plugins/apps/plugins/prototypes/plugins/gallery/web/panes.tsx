import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import {
  prototypesApp,
  prototypesGalleryColumnRoute,
  prototypesGalleryRoute,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { CanvasGround } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PrototypeGallery } from "./components/prototype-gallery";

/** The gallery root pane: bare `/prototypes`. */
export const prototypesGalleryPane = Pane.define({
  title: "Prototypes",
  route: prototypesGalleryRoute,
  app: prototypesApp,
  appIndex: true,
  component: PrototypesGalleryBody,
});

/**
 * The gallery lies on the viewer's own ground (the canvas grid), so a card and
 * the frame it opens sit on the same surface. The ground stays put while the
 * cards scroll over it. The pane header's title, the DataView toolbar and the
 * cards share one pane-relative edge (`inset="content"`, the theme's
 * `contentInset` — the gallery mock's `--inset`).
 */
function PrototypesGalleryBody() {
  return (
    <PaneChrome
      pane={prototypesGalleryPane}
      ground={<CanvasGround />}
      inset="content"
    >
      <PrototypeGallery />
    </PaneChrome>
  );
}

/**
 * The same gallery as a Miller column beside another surface — the agent
 * manager's Prototypes button opens it next to the conversation. A pane of its
 * own because the gallery root is the app's index pane: it has no URL part of
 * its own, so as a column the URL would not name it (gone on reload). Its own
 * segment (`prototypes`) makes the column addressable; a card's canvas takes
 * the column over (`opensInPlace`), as it replaces the root.
 */
export const prototypesGalleryColumnPane = Pane.define({
  title: "Prototypes",
  route: prototypesGalleryColumnRoute,
  app: prototypesApp,
  component: PrototypesGalleryColumnBody,
  // A navigator column: a card's canvas takes this column, as it replaces the
  // gallery root in the app itself, rather than stacking a third column.
  opensInPlace: true,
});

function PrototypesGalleryColumnBody() {
  return (
    <PaneChrome
      pane={prototypesGalleryColumnPane}
      ground={<CanvasGround />}
      inset="content"
    >
      <PrototypeGallery />
    </PaneChrome>
  );
}
