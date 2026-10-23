import { defineHintAnchor, defineHintSignal } from "@plugins/hints/core";

/** The Improve segment of the toolbar's Improve pill. */
export const improveButtonAnchor = defineHintAnchor("improve.button");

/** The open Improve popover's draft form. */
export const improvePanelAnchor = defineHintAnchor("improve.panel");

/** The draft form's Send ("Create task") button. */
export const improveSendAnchor = defineHintAnchor("improve.send");

/** A request was sent from Improve: the tasks it filed. */
export const improveSent = defineHintSignal<{ taskIds: string[] }>(
  "improve.sent",
);
