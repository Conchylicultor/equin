import { defineHintAnchor } from "@plugins/hints/core";

/**
 * The global action bar, whichever host draws it: the docked strip in the tab
 * bar, or the floating bar's collapsed footprint (the dot it unfolds from) —
 * so hovering the anchor is hovering what unfolds the bar.
 */
export const actionBarAnchor = defineHintAnchor("shell.action-bar");
