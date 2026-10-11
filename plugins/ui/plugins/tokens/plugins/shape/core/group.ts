import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

export const shapeGroup = defineTokenGroup("shape", {
  radius: { default: "0.625rem", label: "Border radius" },
  spacing: { default: "0.25rem", label: "Base spacing" },
  // A raised card's corners (`Card`, `Surface level="raised"` via
  // `rounded-card`). Default = the `rounded-md` step it always wore.
  radiusCard: { default: "calc(var(--radius) * 0.8)", label: "Card radius" },
  // A Button's corners (`rounded-control`): the `md` / `lg` sizes and every
  // segment of a ButtonGroup. Default = the `rounded-lg` step, i.e. `--radius`
  // itself.
  radiusControl: { default: "var(--radius)", label: "Control radius" },
  // The `sm` / `xs` Button sizes' corners (`rounded-control-sm` /
  // `rounded-control-xs`). Defaults = the capped `rounded-md` step they always
  // wore, so a big `--radius` does not turn a small button into a pill. Their
  // own roles (not `radiusControl`) so a container that rounds every control
  // inside it — a pill capsule — reaches these sizes too.
  radiusControlSm: {
    default: "min(calc(var(--radius) * 0.8), 12px)",
    label: "Small control radius",
  },
  radiusControlXs: {
    default: "min(calc(var(--radius) * 0.8), 10px)",
    label: "Compact control radius",
  },
  // A transcript card's tool-name badge: its corners (default = the compact
  // chip's, the rung it sits on) and its hairline, drawn in its own text
  // colour. Width 0 = no border, as always.
  radiusToolBadge: {
    default: "var(--radius-chip-compact)",
    label: "Tool badge radius",
  },
  borderToolBadge: { default: "0px", label: "Tool badge border width" },
  // An inline `code` span: its corners (default the `rounded-md` step) and its
  // hairline (width 0 = none; colour = the palette's `codeBorder`).
  radiusCode: {
    default: "calc(var(--radius) * 0.8)",
    label: "Inline code radius",
  },
  borderCode: { default: "0px", label: "Inline code border width" },
  // The extra inline room a fully-rounded end needs over a rectangle's corner,
  // added on top of the control size's own padding (`controlPad*`) on every
  // side that is a pill end — both sides of a pill button or chip, the outer
  // side of a split pill's first and last segment. A shape property, not a
  // density one: at the same size a pill and a rectangle share one padding and
  // differ only by this. 0 = pills pad exactly like rectangles.
  // A floating panel's corners (`Surface level="overlay"`: every popover, menu
  // and dialog) and a control-panel row's. Defaults = the `rounded-lg` /
  // `rounded-md` steps they always wore.
  radiusPopover: { default: "var(--radius)", label: "Popover radius" },
  radiusPanelRow: {
    default: "calc(var(--radius) * 0.8)",
    label: "Panel row radius",
  },
  pillPadExtra: { default: "0rem", label: "Pill extra padding" },
});

export type ShapeTokenValues = {
  [K in keyof typeof shapeGroup.schema]: string;
};
