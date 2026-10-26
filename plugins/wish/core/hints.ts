import { defineHintAnchor, defineHintSignal } from "@plugins/hints/core";

/** The Improve segment of the toolbar's Improve pill. */
export const wishButtonAnchor = defineHintAnchor("wish.button");

/** The open Improve popover's draft form. */
export const wishPanelAnchor = defineHintAnchor("wish.panel");

/** The draft form's Send ("Create task") button. */
export const wishSendAnchor = defineHintAnchor("wish.send");

/** A request was sent from Improve: the tasks it filed. */
export const wishSent = defineHintSignal<{ taskIds: string[] }>("wish.sent");
