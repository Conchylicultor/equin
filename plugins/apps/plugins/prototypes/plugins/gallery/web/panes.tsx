import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import {
  prototypesApp,
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
  width: 360,
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
