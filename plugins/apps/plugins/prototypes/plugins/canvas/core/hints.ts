import { defineHint, defineHintAnchor } from "@plugins/hints/core";

/** A frame header's options chip — the newest one on the page. */
export const optionsChipAnchor = defineHintAnchor("prototypes.options-chip");

/** Shown the first time a prototype with options opens: its variants live here. */
export const variantsHint = defineHint({
  id: "prototypes.variants",
  anchor: optionsChipAnchor,
  title: "Variants",
  body: "Click to switch between the alternative designs of this prototype.",
  placement: "bottom",
});
