import { both, defineSubTheme } from "@plugins/ui/plugins/theme-engine/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";

/*
 * The canvas's own control densities, as sub-themes: each region below holds
 * controls the app's rungs do not draw, so it wears the sizes its mockup
 * (`proto-1792527153-l4fzh8`) gives them. Sizes only — the colours stay the
 * app's, and a popup opened from a region leaves it. Contributed through
 * `ThemeEngine.SubTheme` by the canvas barrel.
 */

/**
 * A frame header's box (`.fbox`) and the version list's filter chip
 * (`.chip`): 22px controls on the `sm` rung — the options chip (padding 0 7px,
 * a 6px icon gap, 13px glyphs), the version label and the filter chip, all at
 * radius 6 — and the stepper's 20px arrows on the `xs` rung (radius 5, 13px
 * glyphs).
 */
export const frameChipsTheme = defineSubTheme({
  id: "prototypes-frame-chips",
  label: "Prototype frame chips",
  fragments: [
    densityGroup.fragment(
      both({
        controlHeightSm: "1.375rem",
        controlPadSm: "0.4375rem",
        controlGapSm: "0.375rem",
        controlIconSm: "0.8125rem",
        controlHeightXs: "1.25rem",
        controlIconXs: "0.8125rem",
      }),
    ),
    shapeGroup.fragment(
      both({
        radiusControlSm: "0.375rem",
        radiusControlXs: "0.3125rem",
      }),
    ),
  ],
});

/**
 * The Options popover's rows (`.orow`): inset 6px 10px, 24px value pills on
 * the `xs` rung, padded 0 9px at radius 7, and the row's link / split buttons
 * beside them drawing 15px glyphs at the same radius.
 */
export const optionRowsTheme = defineSubTheme({
  id: "prototypes-option-rows",
  label: "Prototype option rows",
  fragments: [
    densityGroup.fragment(
      both({
        padRowX: "0.625rem",
        padRowY: "0.375rem",
        controlPadXs: "0.5625rem",
        controlIconXs: "0.9375rem",
      }),
    ),
    shapeGroup.fragment(both({ radiusControlXs: "0.4375rem" })),
  ],
});

/** The version list's rows (`.vlist li`): inset 8px 10px. */
export const versionRowsTheme = defineSubTheme({
  id: "prototypes-version-rows",
  label: "Prototype version rows",
  fragments: [
    densityGroup.fragment(both({ padRowX: "0.625rem", padRowY: "0.5rem" })),
  ],
});
