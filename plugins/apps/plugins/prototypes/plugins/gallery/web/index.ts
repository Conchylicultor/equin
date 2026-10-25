import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { prototypeDetailPane } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { prototypesGalleryPane } from "./panes";
import {
  PrototypeCardActions,
  PrototypeGallerySources,
  PrototypeTrashActions,
} from "./slots";
import { GallerySource, TrashSource } from "./components/prototype-gallery";
import {
  DoneCardAction,
  DoneHeaderAction,
  useDoneActive,
} from "./components/done-toggle";
import {
  PinCardAction,
  PinHeaderAction,
  usePinnedActive,
} from "./components/pin-toggle";
import {
  DeleteCardAction,
  DeleteHeaderAction,
} from "./components/delete-prototype";
import { RestoreCardAction } from "./components/trash";
import { TagHeaderAction } from "./components/tag-chip";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { prototypesGalleryPane } from "./panes";
export { PrototypeCardActions } from "./slots";
export type { PrototypeGalleryRow } from "./slots";

export default {
  description:
    "Prototypes gallery list pane — one card per prototype over its rendered preview, on the prototype viewer's grid, with a Recently edited list; grouped by its tag as nested sections along the prototypes' tag tree (or by status: Pinned / In progress / Done), with a pin and a Done circle on every card and row (hover actions that stay shown while set; also in the detail pane's header, beside the tag chip opening the shared tag picker), an undoable Delete on every card and in the detail header (deletedAt in the prototype's state — the folder stays), and a Trash view (its own source in the same view bar) listing the deleted ones with Restore — plus New prototype, which mints the folder before launching the agent that designs it.",
  contributions: [
    Pane.Register({ pane: prototypesGalleryPane }),
    // The view bar's two sources: the live prototypes and the deleted ones.
    PrototypeGallerySources({
      id: "gallery",
      title: "Prototypes",
      icon: symbol("grid-view"),
      views: ["gallery", "list"],
      component: GallerySource,
    }),
    PrototypeGallerySources({
      id: "trash",
      title: "Trash",
      icon: symbol("delete"),
      views: ["gallery", "list"],
      component: TrashSource,
    }),
    // The open prototype's tag, pin and Done — the same state as the card's,
    // contributed into the canvas plugin's detail header.
    prototypeDetailPane.Actions({ id: "tag", component: TagHeaderAction }),
    prototypeDetailPane.Actions({ id: "pin", component: PinHeaderAction }),
    prototypeDetailPane.Actions({ id: "done", component: DoneHeaderAction }),
    // Delete the open prototype (undoable from its toast) — Restore instead
    // while it is deleted.
    prototypeDetailPane.Actions({
      id: "delete",
      component: DeleteHeaderAction,
    }),
    // The pin and the Done circle: hover actions on every card and list row
    // (the default `revealed` zone), each RESTING while it is on — so a pinned
    // or finished prototype says so at rest, and the rest appear on hover.
    PrototypeCardActions({
      id: "pin",
      component: PinCardAction,
      useActive: usePinnedActive,
    }),
    PrototypeCardActions({
      id: "done",
      component: DoneCardAction,
      useActive: useDoneActive,
    }),
    // Delete, last in the hover cluster (after present's Open in a new tab).
    PrototypeCardActions({
      id: "delete",
      component: DeleteCardAction,
    }),
    // A Trash card's one action: back into the gallery.
    PrototypeTrashActions({ id: "restore", component: RestoreCardAction }),
  ],
  slots: {
    "prototypes-gallery": prototypesGalleryPane,
    sources: PrototypeGallerySources,
    "card-actions": PrototypeCardActions,
    "trash-actions": PrototypeTrashActions,
  },
} satisfies PluginDefinition;
