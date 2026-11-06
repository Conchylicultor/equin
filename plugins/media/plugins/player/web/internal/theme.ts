import {
  both,
  defineFixedTheme,
  defineSubTheme,
} from "@plugins/ui/plugins/theme-engine/core";
import {
  fixedThemeScope,
  subThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { overlayGroup } from "@plugins/ui/plugins/tokens/plugins/overlay/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { SLIM } from "./geometry";

// The prototype's palette (`proto-1793924689-zwfacl`), by its own names.
const WHITE = "oklch(1 0 0)"; // --fg
const FG_DIM = "oklch(1 0 0 / 0.78)"; // --fg-dim
const ACCENT = "oklch(0.5990 0.2299 286.20)"; // --accent: violet, #7c5cff
const BLACK = "oklch(0 0 0)"; // the player behind the video
const INK = "oklch(0.1931 0.0080 285.63)"; // rgb(20 20 24): tooltips, the time bubble, the badge's ring
const TOOLTIP = "oklch(0.1931 0.0080 285.63 / 0.9)";
const HOVER = "oklch(1 0 0 / 0.14)"; // a button hovered or open; a key cap
const ROW_HOVER = "oklch(1 0 0 / 0.09)"; // a settings row hovered
const HAIRLINE = "oklch(1 0 0 / 0.12)"; // the bubble's and tooltip's ring
const GLASS_EDGE = "oklch(1 0 0 / 0.16)"; // every glass surface's border
const SWITCH_OFF = "oklch(1 0 0 / 0.2)";
const FOCUS = "oklch(1 0 0 / 0.6)";

// The `clear` glass — the one shipped. Its siblings in the prototype, for when
// a glass option is wanted: `frosted` (tint rgb(20 20 24 / .42), panel .56,
// blur(24px) saturate(1.3) brightness(.7)) and `dark` (rgb(14 14 18 / .6),
// panel .66, blur(24px) saturate(1.2) brightness(.6)).
const GLASS_TINT = "oklch(0.2793 0.0109 285.67 / 0.26)"; // rgb(40 40 46 / .26): pill, capsule, flash
const GLASS_PANEL = "oklch(0.2367 0.0076 285.81 / 0.44)"; // rgb(30 30 34 / .44): the settings panel
const GLASS_FILTER = "blur(18px) saturate(1.5) brightness(0.82)";
const GLASS_SHADOW =
  "0 10px 30px oklch(0 0 0 / 0.32), inset 0 1px 0 oklch(1 0 0 / 0.07)";

/**
 * What the player's controls wear: dark glass and white glyphs whatever the
 * app's theme — controls over a picture follow the video convention, not the
 * page's light or dark. A fixed theme, so the tooltips and panels opened from
 * the controls wear it too.
 *
 * Its pieces map onto the surface roles: the pill, the volume capsule and the
 * centre feedback are `float` glass (the `material` group's float fill,
 * backdrop and border, `shadow-float`); the settings panel is the denser
 * `overlay` glass (popover fill and backdrop, `shadow-popover`); a hovered or
 * open button is the float surface's hover (`accent`); the accent itself — the
 * played part of the seek bar, the dial's needle, the picked chip, the Loop
 * switch — is `primary`.
 */
export const mediaPlayerTheme = defineFixedTheme({
  id: "media-player",
  label: "Media player controls",
  scheme: "dark",
  fragments: [
    colorPaletteGroup.fragment(
      both({
        background: BLACK,
        foreground: WHITE,
        card: INK,
        cardForeground: WHITE,
        popover: INK,
        popoverForeground: WHITE,
        popoverBorder: GLASS_EDGE,
        popoverHover: ROW_HOVER,
        primary: ACCENT,
        primaryForeground: WHITE,
        secondary: HOVER,
        secondaryForeground: WHITE,
        accent: HOVER,
        accentForeground: WHITE,
        muted: HOVER,
        mutedForeground: FG_DIM,
        border: HAIRLINE,
        input: HAIRLINE,
        ring: FOCUS,
        switchTrack: SWITCH_OFF,
        switchKnob: WHITE,
        switchKnobOn: WHITE,
        sliderKnob: WHITE,
      }),
    ),
    materialGroup.fragment(
      both({
        floatFill: GLASS_TINT,
        floatBackdrop: GLASS_FILTER,
        floatBorder: GLASS_EDGE,
        popoverFill: GLASS_PANEL,
        popoverBackdrop: GLASS_FILTER,
      }),
    ),
    shadowGroup.fragment(
      both({
        "shadow-float": GLASS_SHADOW,
        "shadow-popover": GLASS_SHADOW,
        // The volume knob lifts off the capsule.
        "shadow-slider-knob": "0 1px 4px oklch(0 0 0 / 0.4)",
      }),
    ),
    shapeGroup.fragment(
      both({
        // The pill and the capsule are fully round; the settings panel's
        // corners are 20px at the regular size, scaled.
        radiusFloat: "9999px",
        radiusPopover: `${20 * SLIM.k}px`,
      }),
    ),
    overlayGroup.fragment(
      both({
        tooltipFill: TOOLTIP,
        tooltipBorder: HAIRLINE,
        tooltipRadius: "9999px",
        tooltipPadX: "0.625rem",
        tooltipPadY: "0.25rem",
        tooltipShadow: "none",
        tooltipOffset: "12px",
        tooltipArrowSize: "0px",
      }),
    ),
    densityGroup.fragment(
      both({
        // The pill's buttons: a 30px square holding a 20px glyph.
        controlHeightSm: `${SLIM.button / 16}rem`,
        controlIconSm: "1.25rem",
        // The volume capsule's slider: a 4px track, a 12px knob.
        sliderTrackH: "0.25rem",
        sliderKnobSize: "0.75rem",
      }),
    ),
    typeScaleGroup.fragment(
      both({
        // The times and the settings rows: 13px, regular.
        fontSizeBody: "0.8125rem",
        lineHeightBody: "1.25rem",
        // The speed readout and the centre flash: 15px, semibold.
        fontSizeSubheading: "0.9375rem",
        lineHeightSubheading: "1.25rem",
        // The gear's speed badge: 9px bold figures on a 13px line.
        fontSizeTagCompact: "0.5625rem",
        lineHeightTagCompact: "0.8125rem",
      }),
    ),
    // The prototype's glyphs are Material's filled ones.
    iconsGroup.fragment(both({ iconFill: "filled" })),
  ],
});

export const mediaPlayerThemeScope = fixedThemeScope(mediaPlayerTheme);

/**
 * The settings panel is drawn at the pill's scale: every measure of it is the
 * regular design times `SLIM.k` — its words through the type scale's
 * `fontScale`, its geometry in `media-player.css`.
 */
export const mediaSettingsTheme = defineSubTheme({
  id: "media-player-settings",
  label: "Media player settings panel",
  fragments: [typeScaleGroup.fragment(both({ fontScale: `${SLIM.k}` }))],
});

export const mediaSettingsThemeScope = subThemeScope(mediaSettingsTheme);

/**
 * The volume capsule's slider: a white fill on a 30% white track, its keyboard
 * focus a soft white halo — the seek bar keeps the accent for the played part.
 */
export const mediaVolumeTheme = defineSubTheme({
  id: "media-player-volume",
  label: "Media player volume",
  fragments: [
    colorPaletteGroup.fragment(
      both({
        primary: WHITE,
        border: "oklch(1 0 0 / 0.3)",
        ring: "oklch(1 0 0 / 0.35)",
      }),
    ),
  ],
});

export const mediaVolumeThemeScope = subThemeScope(mediaVolumeTheme);
