import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { prototypeDetailPane } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { prototypesGalleryPane } from "./panes";
import { PrototypeCardActions } from "./slots";
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

export { prototypesGalleryPane } from "./panes";
export {
  mintPrototypeFolder,
  newPrototypePrompt,
} from "./components/new-prototype";
export { useSetPrototypeStatus } from "./components/set-status";
export { PrototypeCardActions } from "./slots";
export type { PrototypeGalleryRow } from "./slots";

export default {
  description:
    "Prototypes gallery list pane — one card per prototype over its rendered preview, on the prototype viewer's grid, with a Recently edited list; grouped (Pinned / In progress / Done) and filterable by a pin and a Done circle on every card and row (hover actions that stay shown while set; also in the detail pane's header), a confirmed Delete on every card and in the detail header (the folder moves to the data dir's _trash/) — plus New prototype, which mints the folder before launching the agent that designs it.",
  contributions: [
    Pane.Register({ pane: prototypesGalleryPane }),
    // Mark the open prototype Done — the same shared flag as the card
    // checkbox, contributed into the canvas plugin's detail header.
    prototypeDetailPane.Actions({ id: "pin", component: PinHeaderAction }),
    prototypeDetailPane.Actions({ id: "done", component: DoneHeaderAction }),
    // Delete the open prototype (confirmed; its folder moves to `_trash/`).
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
      order: 10,
    }),
    PrototypeCardActions({
      id: "done",
      component: DoneCardAction,
      useActive: useDoneActive,
      order: 20,
    }),
    // Delete, last in the hover cluster (after present's Open in a new tab).
    PrototypeCardActions({
      id: "delete",
      component: DeleteCardAction,
      order: 90,
    }),
  ],
  slots: {
    "prototypes-gallery": prototypesGalleryPane,
    "card-actions": PrototypeCardActions,
  },
} satisfies PluginDefinition;
