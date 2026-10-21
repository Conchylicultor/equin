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
  // step it always wore.
  "shadow-popover": {
    default: "var(--shadow-md)",
    label: "Shadow popover",
  },
  // Floating chrome's shadow (`Surface level="float"`: a toolbar card or dock
  // over content). Default = the popover's, so the two float alike unless a
  // theme sets them apart.
  "shadow-float": {
    default: "var(--shadow-popover)",
    label: "Shadow float",
  },
});

export type ShadowTokenValues = {
  [K in keyof typeof shadowGroup.schema]: string;
};
