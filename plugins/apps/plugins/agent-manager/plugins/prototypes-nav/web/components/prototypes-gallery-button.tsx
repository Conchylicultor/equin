import {
  PaneIconAction,
  useOpenPane,
} from "@plugins/primitives/plugins/pane/web";
import { prototypesGalleryPane } from "@plugins/apps/plugins/prototypes/plugins/gallery/web";
import { prototypesApp } from "@plugins/apps/plugins/prototypes/plugins/shell/core";

export function PrototypesGalleryButton() {
  const openPane = useOpenPane();
  // The gallery is a full-surface app index (a grid of cards over the canvas
  // ground), too wide to sit as a Miller column beside the chat — so it opens
  // as its own app: the gallery pane rooted, which the pane router hands to
  // the cross-app navigator. A real link, so ⌘/middle-click opens a new tab.
  return (
    <PaneIconAction
      label="Prototypes"
      icon={prototypesApp.icon}
      {...openPane.link(prototypesGalleryPane, {}, { mode: "root" })}
    />
  );
}
