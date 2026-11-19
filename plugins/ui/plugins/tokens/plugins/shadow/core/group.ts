import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

export const shadowGroup = defineTokenGroup("shadow", {
  "shadow-2xs": {
    default: "0 1px 3px 0px oklch(0 0 0 / 0.05)",
    label: "Shadow 2XS",
  },
  "shadow-xs": {
    default: "0 1px 3px 0px oklch(0 0 0 / 0.05)",
    label: "Shadow XS",
  },
  "shadow-sm": {
    default:
      "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 1px 2px -1px oklch(0 0 0 / 0.10)",
    label: "Shadow SM",
  },
  shadow: {
    default:
      "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 1px 2px -1px oklch(0 0 0 / 0.10)",
    label: "Shadow",
  },
  "shadow-md": {
    default:
      "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 2px 4px -1px oklch(0 0 0 / 0.10)",
    label: "Shadow MD",
  },
  "shadow-lg": {
    default:
      "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 4px 6px -1px oklch(0 0 0 / 0.10)",
    label: "Shadow LG",
  },
  "shadow-xl": {
    default:
      "0 1px 3px 0px oklch(0 0 0 / 0.10), 0 8px 10px -1px oklch(0 0 0 / 0.10)",
    label: "Shadow XL",
  },
  "shadow-2xl": {
    default: "0 1px 3px 0px oklch(0 0 0 / 0.25)",
    label: "Shadow 2XL",
  },
  // A floating panel's shadow (`Surface level="overlay"`). Default = the `md`
  // step it always wore on light. On dark, a 10% black shadow does not show:
  // a theme whose popover is its canvas tone (shadcn's convention) drew menus
  // indistinguishable from the page and from each other. The dark default is
  // the macOS menu edge: a dark 1px stroke outside the light `popoverBorder`
  // hairline (the double stroke that parts a submenu from the menu it lands
  // on), a soft halo on every side, and a deep drop below. Kept to macOS's
  // weight (1px, ~55% black): a 2px 85% ring read as a thick black outline.
  "shadow-popover": {
    default: "var(--shadow-md)",
    darkDefault:
      "0 0 0 1px oklch(0 0 0 / 0.55), 0 0 16px 0px oklch(0 0 0 / 0.3), 0 12px 32px -8px oklch(0 0 0 / 0.55)",
    label: "Shadow popover",
  },
  // Floating chrome's shadow (`Surface level="float"`: a toolbar card or dock
  // over content). Default = the popover's, so the two float alike unless a
  // theme sets them apart. On dark, the drop alone: the popover's double
  // stroke parts stacked menus, and floating chrome draws its own real border.
  "shadow-float": {
    default: "var(--shadow-popover)",
    darkDefault:
      "0 10px 30px -8px oklch(0 0 0 / 0.6), 0 2px 6px 0px oklch(0 0 0 / 0.35)",
    label: "Shadow float",
  },
  // A record's cover (the DataView gallery card), at rest and under the
  // pointer (`shadow-cover` / `hover:shadow-cover-hover`). Defaults = the `sm`
  // and `xl` tiers: a cover sits on the page and lifts when hovered.
  "shadow-cover": { default: "var(--shadow-sm)", label: "Shadow cover" },
  "shadow-cover-hover": {
    default: "var(--shadow-xl)",
    label: "Shadow cover hover",
  },
  // A slider's knob (`css/slider`), under its halo. Default none (a
  // transparent zero shadow, so it composes in a shadow list): a knob on a
  // plain track sits flat; one floated over a picture (the media player's
  // volume) lifts off it.
  "shadow-slider-knob": {
    default: "0 0 #0000",
    label: "Shadow slider knob",
  },
});

export type ShadowTokenValues = {
  [K in keyof typeof shadowGroup.schema]: string;
};
