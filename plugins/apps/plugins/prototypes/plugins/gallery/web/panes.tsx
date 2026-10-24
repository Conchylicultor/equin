import {
  Pane,
  PaneChrome,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import {
  prototypesApp,
  prototypesGalleryRoute,
  prototypesTrashRoute,
} from "@plugins/apps/plugins/prototypes/plugins/shell/core";
import { CanvasGround } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import {
  PrototypeGallery,
  PrototypeTrash,
} from "./components/prototype-gallery";

/** The gallery root pane: bare `/prototypes`. */
export const prototypesGalleryPane = Pane.define({
  title: "Prototypes",
  route: prototypesGalleryRoute,
  app: prototypesApp,
  appIndex: true,
  component: PrototypesGalleryBody,
  width: 360,
});

/** The gallery's Trash: `/prototypes/trash`, every deleted prototype. */
export const prototypesTrashPane = Pane.define({
  title: "Trash",
  route: prototypesTrashRoute,
  app: prototypesApp,
  component: PrototypesTrashBody,
  width: 360,
});

/**
 * The gallery lies on the viewer's own ground (the canvas grid), so a card and
 * the frame it opens sit on the same surface. The ground stays put while the
 * cards scroll over it.
 */
function PrototypesGalleryBody() {
  const openPane = useOpenPane();
  return (
    <PaneChrome pane={prototypesGalleryPane} ground={<CanvasGround />}>
      <PrototypeGallery
        openTrash={() => openPane.to(prototypesTrashPane, {}, { mode: "push" })}
      />
    </PaneChrome>
  );
}

/** The Trash, on the same ground as the gallery it belongs to. */
function PrototypesTrashBody() {
  return (
    <PaneChrome pane={prototypesTrashPane} ground={<CanvasGround />}>
      <PrototypeTrash />
    </PaneChrome>
  );
}
