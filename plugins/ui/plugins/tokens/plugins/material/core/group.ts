import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

/**
 * What a floating panel (`Surface level="overlay"`: every popover, menu,
 * select, dialog) is made of. The defaults are the opaque panel it always was,
 * so a theme that says nothing about this group changes nothing; a frosted
 * theme mixes the fill with transparent and blurs what shows through.
 *
 * The fill is its own token rather than a translucent `popover`: `popover`
 * also paints what must stay opaque over scrolled content inside the panel
 * (its sticky header, a select's scroll buttons, the `--chrome-mask` a pinned
 * bar paints), and every colour group expects an opaque palette.
 */
export const materialGroup = defineTokenGroup("material", {
  // The panel's background (`bg-popover-fill`). Default = the popover tone.
  popoverFill: {
    default: "var(--popover)",
    label: "Popover fill",
  },
  // A CSS `backdrop-filter` applied to what shows through the panel
  // (`backdrop-popover`), e.g. `blur(30px) saturate(1.8)`. Default `none`.
  popoverBackdrop: {
    default: "none",
    label: "Popover backdrop filter",
  },
});

export type MaterialTokenValues = {
  [K in keyof typeof materialGroup.schema]: string;
};
