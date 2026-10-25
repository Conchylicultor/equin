import { both, defineTheme } from "@plugins/ui/plugins/theme-engine/core";
import { colorPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/color-palette/core";
import { chordPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/chord-palette/core";
import { fontFamilyGroup } from "@plugins/ui/plugins/tokens/plugins/font-family/core";
import { shapeGroup } from "@plugins/ui/plugins/tokens/plugins/shape/core";
import { shadowGroup } from "@plugins/ui/plugins/tokens/plugins/shadow/core";
import { typeScaleGroup } from "@plugins/ui/plugins/tokens/plugins/type-scale/core";
import { densityGroup } from "@plugins/ui/plugins/tokens/plugins/density/core";
import { iconsGroup } from "@plugins/ui/plugins/tokens/plugins/icons/core";
import { materialGroup } from "@plugins/ui/plugins/tokens/plugins/material/core";
import { overlayGroup } from "@plugins/ui/plugins/tokens/plugins/overlay/core";
import { dataViewGroup } from "@plugins/ui/plugins/tokens/plugins/data-view/core";

// The immersive player's night (proto-1792113547-2qr6g7): a blue-black stage,
// warm off-white text whose quieter tiers are the same ink at lower alpha, and
// hairlines in translucent white — so every tier reads the same over the stage,
// a floating bar or a panel.
const STAGE = "#0d0d13";
const PANEL = "#111118";
const MENU = "#1b1b24";
const TEXT = "#f1efea";
const MUTED = "rgb(241 239 234 / 0.6)";
const FAINT = "rgb(241 239 234 / 0.36)";
const HAIR = "rgb(255 255 255 / 0.08)";
const HAIR_2 = "rgb(255 255 255 / 0.13)";
const CHIP = "rgb(255 255 255 / 0.06)";
const CHIP_HI = "rgb(255 255 255 / 0.11)";
const ACCENT = "#8fb8ff";
const ON_ACCENT = "#101014";
const OK = "#6fe0a0";
const WARN = "#ffc56b";
const ERR = "#ff8577";

/**
 * Surfaces and text. `primary` is the mockup's one accent, sky: the now-line,
 * the progression fill, a switch that is on. `accent` — the palette's hover and
 * selection fill — is the mockup's lighter chip (11% white), never a colour, so
 * hovering a control lifts it rather than tinting it.
 *
 * Written with `both(…)`: light mode gets the same dark values, which is what
 * makes the app dark only (light/dark is one global setting today).
 */
const colorPalette = colorPaletteGroup.fragment(
  both({
    background: STAGE,
    foreground: TEXT,
    card: PANEL,
    cardForeground: TEXT,
    popover: MENU,
    popoverForeground: TEXT,
    primary: ACCENT,
    // The mockups' `--on-accent` over sky (oklch 0.14 — near-black).
    primaryForeground: "#090909",
    secondary: CHIP,
    secondaryForeground: TEXT,
    muted: CHIP,
    mutedForeground: MUTED,
    faintForeground: FAINT,
    accent: CHIP_HI,
    accentForeground: TEXT,
    destructive: ERR,
    destructiveForeground: ON_ACCENT,
    success: OK,
    successForeground: ON_ACCENT,
    warning: WARN,
    warningForeground: ON_ACCENT,
    info: ACCENT,
    infoForeground: ON_ACCENT,
    border: HAIR,
    input: HAIR_2,
    ring: ACCENT,
    popoverBorder: HAIR_2,
    popoverHover: CHIP_HI,
    selected: CHIP_HI,
    chip: CHIP,
    field: "rgb(0 0 0 / 0.3)",
    outlineBorder: HAIR,
    outlineFill: CHIP,
    outlineHover: CHIP_HI,
  }),
);

/**
 * The chord colours, one per numeral's number (I orange … VII teal) — the
 * Chord app's palette, which every chord surface of the player paints in.
 * Stated even though they are the palette's defaults today, so the player keeps
 * the mockup's look whatever the defaults become.
 */
const chordPalette = chordPaletteGroup.fragment(
  both({
    "chord-1": "#EC8A3A",
    "chord-2": "#E2B23A",
    "chord-3": "#DE6A9A",
    "chord-4": "#7FB685",
    "chord-5": "#3AA4D0",
    "chord-6": "#9C6FE6",
    "chord-7": "#2FB5A8",
    "chord-outside": "#8C8A85",
  }),
);

/** Manrope for every surface, JetBrains Mono for the chord-grid source. */
const fontFamily = fontFamilyGroup.fragment(
  both({
    fontSans: "'Manrope', sans-serif",
    fontMono: "'JetBrains Mono', monospace",
    letterSpacing: "0em",
    fontSmoothing: "antialiased",
  }),
);

/** The mockup's type: 13px body, 12px semibold controls, a 15px song title. */
const typeScale = typeScaleGroup.fragment(
  both({
    fontSizeSubheading: "0.9375rem",
    fontSizeBody: "0.8125rem",
    // The mockups' 13px/1.35 body line (17.55px, on the 1px grid: 18).
    lineHeightBody: "1.125rem",
    fontSizeLabel: "0.78125rem",
    fontSizeCaption: "0.71875rem",
    fontSizeControl: "0.75rem",
    fontWeightControl: "600",
    // The library (proto-1792667077-4bakda): a group header's 15px bold
    // label, a card title's 13.5px on an 18px line, the 12px mono cells and
    // the card subtitle's 12px on a 17px line.
    fontSizeGroup: "0.9375rem",
    lineHeightGroup: "1.25rem",
    fontWeightGroup: "700",
    fontSizeHeading: "0.84375rem",
    lineHeightHeading: "1.125rem",
    fontSizeCode: "0.75rem",
    fontSizeTag: "0.75rem",
    lineHeightTag: "1.0625rem",
  }),
);

/**
 * Round everything: controls are pills, floating panels 18px cards — the
 * mockup draws no square corner anywhere.
 */
const shape = shapeGroup.fragment(
  both({
    radius: "0.75rem",
    radiusCard: "0.75rem",
    radiusControl: "999px",
    radiusControlSm: "999px",
    radiusControlXs: "999px",
    radiusPopover: "18px",
    radiusPanelRow: "9px",
    // A song's cover (the library card's picture) — a 16px tile.
    radiusCover: "1rem",
    // Floating chrome (the library's toolbar cards) — pills.
    radiusFloat: "999px",
  }),
);

/**
 * A floating panel lifts well off the stage; floating chrome carries the glass
 * pill's inner top highlight; a cover sits low and rises on hover
 * (proto-1792667077-4bakda).
 */
const shadow = shadowGroup.fragment(
  both({
    "shadow-popover":
      "0 24px 60px rgb(0 0 0 / 0.55), 0 2px 8px rgb(0 0 0 / 0.3)",
    "shadow-float":
      "0 16px 44px rgb(0 0 0 / 0.42), inset 0 1px 0 rgb(255 255 255 / 0.12)",
    "shadow-cover": "0 10px 30px -14px rgb(0 0 0 / 0.7)",
    "shadow-cover-hover": "0 20px 40px -16px rgb(0 0 0 / 0.85)",
  }),
);

/**
 * Floating chrome is the mockup's glass: a dark, half-transparent fill under a
 * strong, saturated blur. (The mockup's faint white top gradient is not
 * spelled: `floatFill` is a colour token, painted as `background-color`.)
 */
const material = materialGroup.fragment(
  both({
    floatFill: "rgb(22 22 32 / 0.55)",
    floatSheen:
      "linear-gradient(180deg, rgb(255 255 255 / 0.075), rgb(255 255 255 / 0.02))",
    floatBorder: HAIR,
    floatBackdrop: "blur(16px) saturate(1.9)",
  }),
);

/**
 * The player's chrome buttons are 34px circles with 17px glyphs — the `lg`
 * rung, which the floating bars declare.
 */
const density = densityGroup.fragment(
  both({
    controlHeightLg: "2.125rem",
    controlIconLg: "1.0625rem",
    // The library gallery: 220px cards, 18px between columns, 24px between rows.
    galleryCardMin: "13.75rem",
    galleryGapX: "1.125rem",
    galleryGapY: "1.5rem",
    // The library's split header: a 48px pane header with no rule, flush on
    // the pane's left (`.phead`, 16px in); ONE inset shared by the toolbar and
    // the content only — 3% of the pane (16–40px), widening to centre a
    // 1520px column on a wide pane.
    chromePaneH: "3rem",
    chromePanePadStart: "1rem",
    chromePanePadEnd: "1rem",
    chromePaneRule: "0px",
    // Its title: 15px bold (`.phead strong`).
    chromePaneTitleRole: "subheading",
    chromePaneTitleEmphasis: "bold",
    contentInset: "max(clamp(16px, 3cqi, 40px), calc((100cqi - 1520px) / 2))",
    // The toolbar's pill items (view chips, icon triggers, search, Add): 32px.
    controlHeightSm: "2rem",
    // The Sonata settings card (proto-1792907625-p861lr, `.sheet`): 440px
    // wide, its content 18px in — this inset plus the 8px row pad.
    popoverWidthSettings: "27.5rem",
    settingsCardPad: "0.625rem",
  }),
);

/**
 * The Sonata settings card's words (proto-1792907625-p861lr): a 14.5px bold
 * title (the 15px subheading, bold), a section heading at 13.5px bold, and its
 * 12px prose (the 12px / 17px tag rung, regular sans).
 */
const overlay = overlayGroup.fragment(
  both({
    settingsTitleRole: "subheading",
    settingsTitleEmphasis: "bold",
    settingsHeadingRole: "heading",
    settingsHeadingEmphasis: "bold",
    settingsProseRole: "tag",
    settingsProseEmphasis: "normal",
    settingsProseFamily: "sans",
  }),
);

/**
 * The library's DataView (proto-1792667077-4bakda, `header: split`): the
 * toolbar's two glass pills, view chips that name only the active view (a
 * filled foreground chip), the gallery card's three fixed lines and its
 * lifting, zooming cover, identity-chip group headers, and the soft table
 * (borderless 56px rows, a 52×34 thumbnail, a hairline from the title on).
 */
const dataView = dataViewGroup.fragment(
  both({
    // ── Type picks ── (measured off the mock: literal, never stepped down in
    // the gallery's compact cards)
    pickStep: "base",
    viewChipRole: "body",
    viewChipEmphasis: "semibold",
    searchRole: "label",
    searchEmphasis: "normal",
    createRole: "control",
    createEmphasis: "bold",
    cardTitleRole: "heading",
    cardTitleEmphasis: "semibold",
    cardSubtitleRole: "tag",
    cardSubtitleEmphasis: "normal",
    cardSubtitleFamily: "sans",
    cardTokenRole: "caption",
    cardTokenEmphasis: "semibold",
    cardTokenFamily: "sans",
    cardTokenNumericRole: "2xs",
    cardTokenNumericEmphasis: "medium",
    cardTokenNumericFamily: "mono",
    groupLabelRole: "group",
    groupLabelEmphasis: "bold",
    groupCountRole: "caption",
    groupCountEmphasis: "medium",
    groupCountFamily: "mono",
    columnHeaderRole: "3xs",
    columnHeaderEmphasis: "bold",
    titleCellRole: "body",
    titleCellEmphasis: "semibold",
    titleCellFamily: "sans",
    titleCellSubtitleRole: "caption",
    titleCellSubtitleEmphasis: "normal",
    titleCellSubtitleFamily: "sans",
    // `.cell.sans` (source, played, added) 12/500 sans; numbers `.cell`
    // 12/500 mono.
    cellRole: "code",
    cellEmphasis: "medium",
    cellFamily: "sans",
    cellNumericRole: "code",
    cellNumericEmphasis: "medium",
    cellInk: MUTED,
    // ── Inks ──
    cardTokenIconInk: "var(--faint-foreground)",
    columnHeaderInk: "var(--faint-foreground)",
    columnHeaderSortedInk: "var(--foreground)",
    viewChipActiveFill: "var(--foreground)",
    viewChipActiveInk: ON_ACCENT,
    pillDividerInk: HAIR_2,
    // A group header's label (the library's "MIDI File") reads in full ink.
    groupLabelInk: TEXT,
    coverRing: "var(--border)",
    // ── Toolbar ──
    toolbarPadY: "0.75rem",
    toolbarGap: "0.625rem",
    toolbarSpaceBelow: "1rem",
    pillPadX: "0.1875rem",
    pillPadY: "0.1875rem",
    pillGap: "0.125rem",
    pillDividerH: "1.125rem",
    pillDividerPadX: "0.1875rem",
    searchWidth: "13.75rem",
    searchWidthNarrow: "8.75rem",
    // The search well: a black 30% pill, a 16px muted glyph, text 30px in.
    searchFill: "rgb(0 0 0 / 0.3)",
    searchRadius: "999px",
    searchIconSize: "1rem",
    searchIconInk: MUTED,
    searchTextStart: "1.875rem",
    // `.add-btn { padding: 0 14px 0 11px }`, less the button's 1px border.
    createPadStart: "0.625rem",
    createPadEnd: "0.8125rem",
    createPadNarrow: "0.5rem", // narrow: `.add-btn { padding: 0 9px }`
    // ── View chip policy ──
    viewChipLabel: "active",
    viewChipActivePadStart: "0.6875rem",
    viewChipActivePadEnd: "0.8125rem",
    viewChipIconSize: "1rem",
    viewChipGap: "0.4375rem",
    viewChipSpacing: "0.125rem", // `.views { gap: 2px }`
    viewSwitcherGap: "0.125rem",
    viewAddSeparator: "show",
    narrowCreateLabel: "hide",
    // ── Gallery card ──
    // The grid starts right under its header (`.ghead`'s 14px is the room).
    galleryBodyPadY: "0px",
    cardMetaPadTop: "0.625rem",
    cardMetaPadX: "0.125rem", // `.meta { padding: 10px 2px 0 }`
    cardTitleLine: "1.125rem",
    cardSubtitleLine: "1.0625rem",
    cardTokensLine: "1.125rem",
    cardSubtitleGap: "0.125rem",
    cardTokensGap: "0.3125rem",
    cardTokenGap: "0.75rem",
    cardTokenIconSize: "0.75rem",
    cardTokenIconGap: "0.3125rem", // `.tok { gap: 5px }`
    // ── Cover ──
    coverLift: "0.1875rem",
    coverZoom: "1.035",
    coverHoverFilter: "brightness(1.12) saturate(1.1)",
    coverFill: PANEL,
    coverRingHover: HAIR_2,
    coverPrimaryFill: "var(--foreground)",
    coverPrimaryInk: ON_ACCENT,
    coverPrimaryShadow: "0 6px 18px rgb(0 0 0 / 0.5)",
    coverPrimarySize: "2.375rem",
    // `.play { right: 10px; bottom: 10px }` / `.more { top: 8px }`, inside the
    // cover's 1px border — measured from the frame's edge, a pixel further.
    coverPrimaryInset: "0.6875rem",
    coverChipInset: "0.5625rem",
    // ── Group headers ──
    groupHeaderGap: "0.625rem",
    groupHeaderPadY: "0.25rem",
    groupHeaderSpaceBelow: "0.875rem",
    groupGap: "1.625rem",
    groupChevronSize: "1rem",
    groupChipSize: "1.625rem",
    groupChipRadius: "0.5rem",
    groupChipFill: CHIP,
    groupChipIconSize: "0.9375rem",
    // ── Soft table ──
    softFrameBorderWidth: "0px",
    softRowH: "3.5rem",
    softRowPad: "0.5rem",
    softRowRadius: "0.875rem",
    softColGap: "0.875rem",
    softRowHoverFill: CHIP,
    softRuleStart: "4.625rem",
    softRuleEnd: "0.625rem", // `.lrow + .lrow::before { right: 10px }`
    titleCellLineGap: "0.0625rem", // `.ltitle .s { margin-top: 1px }`
    softHeaderH: "1.875rem",
    softHeaderSpaceBelow: "0.25rem",
    softThumbW: "3.25rem",
    softThumbH: "2.125rem",
    softThumbRadius: "0.5625rem",
    columnHeaderTracking: "0.12em",
    sortIcon: "sorted",
  }),
);

/**
 * Thin-stroked line icons, as the mockup draws them: Sonata's own family
 * (`sonataIcons`, sonata/primitives/icons), which falls back to each symbol's
 * Lucide counterpart for the names it does not draw.
 */
const icons = iconsGroup.fragment(both({ iconFamily: "sonata" }));

/**
 * Sonata's own theme — the immersive player's night, dark only. Selected for
 * the app in `config/ui/theme-engine/@app/sonata/theme.jsonc`. A group it does
 * not mention paints that group's schema defaults.
 */
export const sonataTheme = defineTheme({
  id: "sonata",
  label: "Sonata",
  fragments: [
    colorPalette,
    chordPalette,
    fontFamily,
    typeScale,
    shape,
    shadow,
    material,
    density,
    dataView,
    overlay,
    icons,
  ],
});
