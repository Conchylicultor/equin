import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

/**
 * How a floating thing behaves and looks beyond its material (`material`) and
 * its corners / shadow (`shape` / `shadow`): how every floating panel
 * (`OverlayPanel`: popover, menu, select, dialog, hover card) ENTERS, and the
 * one-line tooltip's chrome (`TooltipContent`).
 *
 * Every default is the look the app had before the group existed, so a theme
 * that says nothing about it changes nothing: panels appear instantly (a 0ms
 * entry), and the tooltip is the popover-toned label with a faint ring, an
 * arrow and the `md` shadow, 4px off its trigger.
 */
export const overlayGroup = defineTokenGroup("overlay", {
  // The panel's entry (`overlay-enter`, app.css): it fades in from 0 while
  // moving from `overlayEnterTranslate` (a CSS `translate` value, e.g.
  // `0 4px` = rising 4px) and growing from `overlayEnterScale`, over
  // `overlayEnterDuration` along `overlayEnterEasing`. Default 0ms = instant.
  // Off under `prefers-reduced-motion: reduce`, whatever the theme says.
  overlayEnterDuration: { default: "0ms", label: "Panel entry duration" },
  overlayEnterEasing: { default: "ease-out", label: "Panel entry easing" },
  overlayEnterTranslate: {
    default: "0px 0px",
    label: "Panel entry offset",
  },
  overlayEnterScale: { default: "1", label: "Panel entry scale" },
  // The tooltip's fill and ink (`bg-tooltip` / `text-tooltip-foreground`).
  // Defaults = the popover's; an inverted tooltip sets the foreground as the
  // fill and the background as the ink.
  tooltipFill: { default: "var(--popover)", label: "Tooltip fill" },
  tooltipForeground: {
    default: "var(--popover-foreground)",
    label: "Tooltip text",
  },
  // Its 1px ring (`ring-tooltip-border`). Default = the foreground at 10%.
  tooltipBorder: {
    default: "color-mix(in oklab, var(--foreground) 10%, transparent)",
    label: "Tooltip ring",
  },
  // Its corners (`rounded-tooltip`). Default = the `rounded-md` step.
  tooltipRadius: {
    default: "calc(var(--radius) * 0.8)",
    label: "Tooltip radius",
  },
  // Its padding (`p-tooltip`). Defaults = the `md` / `xs` spacing steps.
  tooltipPadX: { default: "var(--space-md)", label: "Tooltip inline padding" },
  tooltipPadY: { default: "var(--space-xs)", label: "Tooltip block padding" },
  // Its drop shadow (`shadow-tooltip`). Default = the `md` tier.
  tooltipShadow: { default: "var(--shadow-md)", label: "Tooltip shadow" },
  // How far it sits off its trigger (`tooltip-offset`, a margin on the side
  // facing the trigger, so placement and flipping account for it).
  tooltipOffset: { default: "4px", label: "Tooltip distance" },
  // Its words: which type ROLE they are set in — a value naming one of the
  // closed ladder's roles (`TYPE_ROLES`, text plugin), never a size — and
  // whether the role's strong weight is used (`regular` | `strong`; only the
  // roles with a strong step, `control` and `tag`, have one). Read by
  // `TooltipContent` through CSS style queries (`TOOLTIP_ROLE_CLASS`, ui-kit),
  // so the size, leading and weight stay the type-scale group's. Default =
  // the `caption` role, regular.
  tooltipRole: { default: "caption", label: "Tooltip type role" },
  tooltipEmphasis: { default: "regular", label: "Tooltip emphasis" },
  // The arrow's square (`tooltip-arrow`); `0px` draws no arrow.
  tooltipArrowSize: { default: "0.625rem", label: "Tooltip arrow size" },
});

export type OverlayTokenValues = {
  [K in keyof typeof overlayGroup.schema]: string;
};
