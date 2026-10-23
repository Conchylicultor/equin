import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { overlayGroup } from "@plugins/ui/plugins/tokens/plugins/overlay/core";

/*
 * The Prototypes look: the canvas-viewer mockup (`proto-1792527153-l4fzh8`),
 * its `neutral` tone and the apricot accent. Every constant is the mockup's
 * `:root[data-tone="neutral"]` custom property of the same name (`--rgb` is
 * 255, 255, 255 in that tone). The mockup is dark only, so every fragment is
 * written with `both(…)`: light mode wears the same dark values.
 */
const BG = "#09090b"; // --bg
const SURFACE = "#111113"; // --surface
const SURFACE_2 = "#161618"; // --surface-2
const POP = "#18181b"; // --pop
const TEXT = "#ededef"; // --text
const MUTED = "#93939a"; // --muted
const DIM = "#5f5f66"; // --dim
const RAISE = "rgba(255, 255, 255, 0.04)"; // --raise
const RAISE_2 = "rgba(255, 255, 255, 0.07)"; // --raise-2
const LINE = "rgba(255, 255, 255, 0.07)"; // --line
const LINE_2 = "rgba(255, 255, 255, 0.11)"; // --line-2
const ACCENT = "#e0ad80"; // --accent (apricot)
const ACCENT_LINE = "color-mix(in oklab, #e0ad80 45%, transparent)"; // --accent-line
const ACCENT_GLOW = "color-mix(in oklab, #e0ad80 30%, transparent)"; // --accent-glow

/**
 * Surfaces and text. `primary` is the apricot accent — what is on (a picked
 * value, the current version's number, a switch, a slider's fill) — with the
 * ground's near-black on it, as the mockup's switch knob is. `accent` is NOT
 * the apricot: it is the palette's hover / highlight tone, the mockup's
 * translucent `--raise-2` wash. Every outline (the floating chrome, a frame's
 * ring, a popover, a chip, a divider in a box) is the firmer `--line-2`; the
 * softer `--line` is only a tree guide here.
 *
 * Not tokens: `--faint` (#36363b, the breadcrumb's "/"), `--frame`
 * (#0e0e10), `--accent-soft` (= `bg-primary/14`) and `--grid`.
 */
const colorPalette = colorPaletteGroup.fragment(
  both({
    background: BG,
    foreground: TEXT,
    card: SURFACE,
    cardForeground: TEXT,
    popover: POP,
    popoverForeground: TEXT,
    primary: ACCENT,
    primaryForeground: BG,
    primaryText: ACCENT,
    secondary: SURFACE_2,
    secondaryForeground: TEXT,
    muted: SURFACE_2,
    mutedForeground: MUTED,
    faintForeground: DIM,
    strongForeground: TEXT,
    subtleForeground: MUTED,
    accent: RAISE_2,
    accentForeground: TEXT,
    // The current row (a version, a size): the raise-2 wash; a popover row
    // under the pointer is the lighter raise.
    selected: RAISE_2,
    popoverHover: RAISE,
    groupForeground: MUTED,
    toolbarForeground: MUTED,
    treeGuide: LINE,
    border: LINE_2,
    input: LINE_2,
    popoverBorder: LINE_2,
    outlineBorder: LINE_2,
    outlineFill: "transparent",
    outlineHover: RAISE_2,
    outlineHoverForeground: TEXT,
    field: RAISE,
    popoverField: RAISE,
    popoverFieldBorder: LINE_2,
    composer: RAISE,
    chip: RAISE_2,
    ring: ACCENT_LINE,
    textSelection: ACCENT_GLOW,
    // The Size popover's controls: a text-colour slider knob in a 3px
    // accent-soft halo; a switch's off track is the firmer line, its off knob
    // the muted text (on: the accent track, the ground's ink knob).
    sliderKnob: TEXT,
    sliderKnobRing: `color-mix(in oklab, ${ACCENT} 14%, transparent)`,
    switchTrack: LINE_2,
    switchKnob: MUTED,
    // The mockup draws no status colour; these are the schema's dark values,
    // stated so light mode wears them too.
    destructive: "oklch(0.704 0.191 22.216)",
    destructiveForeground: "oklch(0.985 0 0)",
    success: "oklch(0.72 0.16 142)",
    successForeground: BG,
    warning: "oklch(0.78 0.14 60)",
    warningForeground: BG,
    info: "oklch(0.72 0.14 232)",
    infoForeground: "oklch(0.985 0 0)",
  }),
);

/**
 * The mockup's `.float` (the header card, the bottom dock, the add rail): the
 * surface at 86% under a 20px, 150%-saturated blur — the `float` surface
 * role's material. Popovers stay solid `--pop`.
 */
const material = materialGroup.fragment(
  both({
    floatFill: `color-mix(in oklab, ${SURFACE} 86%, transparent)`,
    floatBackdrop: "blur(20px) saturate(150%)",
  }),
);

/**
 * `shadow-popover` is `.pop`'s, `shadow-float` `.float`'s (each with its 4% /
 * 5% top highlight), `shadow-xl` an add-rail button's and `shadow-2xl` a
 * frame's drop (its 1px `--line-2` ring is `ring-1 ring-border` beside it).
 * `shadow-cover` is a gallery card's `.shot` (the `--line-2` hairline and a
 * long soft drop); under the pointer the hairline turns the accent line and
 * the drop deepens (`.card:hover .shot`).
 */
const shadow = shadowGroup.fragment(
  both({
    "shadow-popover":
      "0 24px 60px -16px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
    "shadow-float":
      "0 12px 40px -12px rgba(0, 0, 0, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
    "shadow-xl": "0 8px 24px -10px rgba(0, 0, 0, 0.7)",
    "shadow-2xl": "0 30px 80px -24px rgba(0, 0, 0, 0.75)",
    "shadow-cover": `0 0 0 1px ${LINE_2}, 0 24px 60px -28px rgba(0, 0, 0, 0.85)`,
    "shadow-cover-hover": `0 0 0 1px ${ACCENT_LINE}, 0 30px 70px -26px rgba(0, 0, 0, 0.9)`,
  }),
);

/**
 * The mockup's corners on a 9px `--radius`: `rounded-lg` 9 (a row, a frame
 * header's box, a dock button), `rounded-xl` 12.6 (a frame's 12), popovers
 * and the floating chrome 14, panel rows 9, buttons 7 (the 24px `xs` ones 6),
 * chips 6 (`radiusChipCompact`, in density), a gallery card's cover 12
 * (the gallery mock's `.shot`).
 */
const shape = shapeGroup.fragment(
  both({
    radius: "0.5625rem",
    radiusCard: "0.5625rem",
    radiusControl: "0.4375rem",
    radiusControlSm: "0.4375rem",
    radiusControlXs: "0.375rem",
    radiusPopover: "0.875rem",
    radiusPanelRow: "0.5625rem",
    radiusCover: "0.75rem",
  }),
);

/**
 * The mockup's `.ib`: a 30px icon button holding a 15px glyph (the `sm` rung,
 * which every Bar declares); a frame header's are 24px with 14px glyphs (the
 * `xs` rung); a chip's corners 6px. A pane header's inline insets are the
 * header card's 6px (`.top-l`'s `padding: 0 6px`) — its 40px row
 * (`chromePaneH`, the default) inside a 1px border is the card's 42px.
 */
const density = densityGroup.fragment(
  both({
    chromePanePadStart: "0.375rem",
    chromePanePadEnd: "0.375rem",
    controlHeightSm: "1.875rem",
    controlIconSm: "0.9375rem",
    controlIconXs: "0.875rem",
    radiusChipCompact: "0.375rem",
    // `.pop`: a popover padded 6px (the default `panel` padding role).
    popoverPad: "0.375rem",
    // `.slider`: a 4px track under a 12px knob.
    sliderTrackH: "0.25rem",
    sliderKnobSize: "0.75rem",
    // `.options` (520px): a frame's Options popover, the `builder` role.
    popoverWidthBuilder: "32.5rem",
    // `.versions` (440px): a frame's version list — choices each carrying
    // their request line, the `described` role.
    popoverWidthDescribed: "27.5rem",
    // The gallery mock's `.grid`: cards at least 250px wide, 26px apart
    // across and 30px down.
    galleryCardMin: "15.625rem",
    galleryGapX: "1.625rem",
    galleryGapY: "1.875rem",
  }),
);

/**
 * Geist and Geist Mono (Google Fonts, which the loader fetches for any
 * catalogued family a theme names), drawn `antialiased` with the body's
 * -0.005em tracking.
 */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Geist', ui-sans-serif, system-ui, sans-serif",
    fontMono: "'Geist Mono', ui-monospace, monospace",
    letterSpacing: "-0.005em",
    fontSmoothing: "antialiased",
  }),
);

/**
 * The mockup's type, as roles: 13px on a 1.4 line inherited (`body`; `label`
 * is the same size at 500 — the breadcrumb's title); 12px `caption` (the size
 * button, a slider's label) and `group` at 500 (a popover's header, a frame's
 * name, the options chip); 12px regular `control` (Fit, a value pill), 500
 * when strong; 11.5px `tag` (a chip; strong = a tooltip's 500) and `code`
 * (`v24`, a size); 11px `2xs` (a version's age, a preset's dims), 10.5px `3xs`.
 */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeBase: "0.8125rem",
    lineHeightBase: "1.4",
    fontSizeBody: "0.8125rem",
    lineHeightBody: "1.125rem",
    fontSizeLabel: "0.8125rem",
    lineHeightLabel: "1.125rem",
    fontSizeCaption: "0.75rem",
    lineHeightCaption: "1rem",
    fontSizeGroup: "0.75rem",
    lineHeightGroup: "1rem",
    fontWeightGroup: "500",
    fontSizeControl: "0.75rem",
    lineHeightControl: "1rem",
    fontWeightControl: "400",
    fontWeightControlStrong: "500",
    fontSizeTag: "0.71875rem",
    lineHeightTag: "1rem",
    fontWeightTag: "400",
    fontWeightTagStrong: "500",
    fontSizeTagCompact: "0.6875rem",
    lineHeightTagCompact: "0.875rem",
    fontSizeCode: "0.71875rem",
    lineHeightCode: "1rem",
    "font-size-2xs": "0.6875rem",
    "line-height-2xs": "0.875rem",
    "font-size-3xs": "0.65625rem",
    "line-height-3xs": "0.875rem",
  }),
);

/**
 * The mockup's `.pop` entry (`@keyframes popin`: from transparent, 4px lower
 * and at 98%, over .14s ease-out) and its inverted tooltip (`[data-tip]`): the
 * text colour as the fill, the ground as the ink, no ring, no shadow, no
 * arrow, 6px corners, 4px × 8px padding, 6px off its trigger (the dock's
 * are 8px in the mockup), its words the strong `tag` role.
 */
const overlay = overlayGroup.fragment(
  both({
    overlayEnterDuration: "140ms",
    overlayEnterEasing: "ease-out",
    overlayEnterTranslate: "0 4px",
    overlayEnterScale: "0.98",
    tooltipFill: TEXT,
    tooltipForeground: BG,
    tooltipBorder: "transparent",
    tooltipRadius: "0.375rem",
    tooltipPadX: "0.5rem",
    tooltipPadY: "0.25rem",
    tooltipShadow: "0 0 #0000",
    tooltipOffset: "6px",
    tooltipArrowSize: "0px",
    // `font: 500 11.5px`: the `tag` role (11.5px here) at its strong weight.
    tooltipRole: "tag",
    tooltipEmphasis: "strong",
  }),
);

/**
 * The mockup's own line glyphs (`prototypesIcons`, prototypes/icons), which
 * fall back to each symbol's Lucide counterpart for the names it does not
 * draw.
 */
const icons = iconsGroup.fragment(both({ iconFamily: "prototypes" }));

/**
 * The Prototypes app's own theme — dark only. Selected for the app in
 * `config/ui/theme-engine/@app/prototypes/theme.jsonc`. A group it does not
 * mention paints that group's schema defaults.
 */
export const prototypesTheme = defineTheme({
  id: "prototypes",
  label: "Prototypes",
  fragments: [
    colorPalette,
    material,
    shadow,
    shape,
    density,
    fontFamily,
    typeScale,
    icons,
    overlay,
  ],
});
