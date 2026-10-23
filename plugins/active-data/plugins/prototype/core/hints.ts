import { defineHint, defineHintAnchor } from "@plugins/hints/core";

/** A prototype id chip in an agent's text — the newest one on the page. */
export const prototypeChipAnchor = defineHintAnchor("prototype.chip");

/** Shown the first time a prototype chip appears: it is what opens the mock. */
export const openPrototypeHint = defineHint({
  id: "prototype.open-chip",
  anchor: prototypeChipAnchor,
  title: "Your prototype",
  body: "Click to open the prototype.",
  placement: "bottom",
  order: 1,
});
