// Single source of truth for the popover width + padding roles. Each is a named
// role mapped to a class via a module-level `Record<Name, string>` indexed by a
// plain prop — mirroring `SURFACE_LEVELS` (theme/surface.ts), no Context.
//
// Co-located in ui-kit (not the `popover` primitive) on purpose: the foundational
// `PopoverContent` consumes these maps directly, and ui-kit is the lowest layer —
// putting the maps here lets it read them without a layer-inverting import cycle,
// while the `popover` primitive (a ui-kit consumer) imports the types
// boundary-legally through the ui-kit barrel.
//
// Width is a CLOSED ramp so a magic Tailwind width can't be sprinkled per call
// site (double-declaration / overflow becomes unrepresentable). `content` is the
// default — size-to-content, matching base-ui's native behavior. Every non-content
// token also carries `max-w-(--available-width)` (base-ui's Positioner exposes the
// CSS var on the popup, same as dropdown-menu.tsx) so no popover overflows a narrow
// viewport. Padding is its own axis, mapped to the `rail-*` @utility classes owned
// by app.css, defaulting to `md` (preserves PopoverContent's previously baked-in padding).
//
// `fit` is the role for a popover whose content has a VARIABLE but bounded natural
// width (e.g. a filter-rule row: `[field] [operator] [value-control]`). It grows to
// its content (`w-max`) with a comfortable `min-w` floor and the same viewport cap.
// Use it instead of a fixed `w-*` whenever a rigid child (a Button/Select trigger
// that can't shrink) would otherwise be clipped when it doesn't fit the fixed box —
// a fixed width can never hold a row of unbounded natural width without overflow.
//
// Three roles size a panel RELATIVE TO ITS TRIGGER rather than to a tier:
//
//   - `anchor` — exactly the trigger's width (a listbox: the closed control and the
//     open list are the same box, so the selected row lands where the value was).
//   - `anchor-min` — at least the trigger's width (and the menu minimum), growing
//     past it for longer item labels (a Select; a picker standing in for a field:
//     the trigger is a floor, not a cap).
//   - `snug` — no meaningful anchor at all: size to content over a small floor.
//
// Two size a MENU, between the density tokens `popoverWidthMenuMin` /
// `popoverWidthMenuMax` — the common rule (Apple, Material, Linear): a menu is
// as wide as its items between a floor and a cap, and a surface never resizes
// while it is open:
//
//   - `menu-fit` — a PLAIN menu, `DropdownMenuContent`'s default (and its
//     submenus'): as wide as its items, clamped to the two tokens, whatever
//     the trigger's width (a menu's width is its content's business). Most
//     menus have short labels and land on the floor, so they match. Both
//     bounds are `min()`ed with the available width, because `min-width`
//     beats `max-width`.
//   - `menu` — a CONTROL PANEL's list of choices (`ControlPanelPopover`):
//     FIXED at the max, because a panel has pages and must not jump between
//     them; so it is exactly as wide as the widest plain menu. A theme that
//     wants every menu one width sets the two tokens equal.
//
// `anchor-min` (a Select, a picker standing in for a field) floors at the menu
// minimum too, so a listbox under a narrow trigger is still a menu's width.
//
// Both anchor roles read `--anchor-width` WITH AN IN-VAR FALLBACK, for the same
// reason `--available-height` carries one below: the var only exists once a
// positioner's `size.apply` has run, and an undefined var invalidates the whole
// `max()` at computed-value time — which would silently drop the menu floor, not
// just the anchor term. Surfaces that publish no anchor at all (a dialog) then
// degrade to the floor rather than to nothing.

// Four roles size a panel by WHAT IT IS rather than by a tier — the
// control-panel vocabulary's only width dial (`ControlPanelPopover size`).
// `menu` is a list of choices (fixed at the menu max, above); `builder` is a six-track rule row; `picker` is a
// panel whose body is a GRID (swatches, icons, cover thumbnails). They are new
// roles rather than aliases of `md` (256px) / `xl` (320px) / `3xl` (480px) on
// purpose: reusing a t-shirt size re-imports the thing the vocabulary exists to
// delete — a panel width chosen because some measurement was nearby, which is
// how the filter panel ended up 481px wide (its FOOTER was the widest row) and
// resized every time a rule was added. The ramp already carries role names
// beside its sizes (`fit`, `snug`, `anchor`, `anchor-min`); these three join
// them.
//
// `picker` earns its place on evidence a single content set could not give: THREE
// shipped panels arrived at 320px independently (the avatar picker, the page icon
// button, the change-cover popover). One panel at a width is a measurement; three
// unrelated ones is a role. Forcing them onto `menu` = 262px is what wraps the
// avatar picker's ten colour swatches onto a second row.
//
// `described` is the fourth: a list of choices whose rows each carry a VISIBLE
// description line (the page-kind menu, where each kind is a policy read before
// it is picked). Its width decides how many lines each description wraps to, so
// a theme sizes it apart from a plain menu of one-word rows — the Pages theme
// draws its section menu at 248px and its kind menu at 300px.
//
// `card` is a hover card (`overlay/hover-card`): one subject described in a
// title, a sentence, chips and a footer. Fixed, so moving the pointer down a
// menu's rows swaps the card's content without resizing it. `card-wide` is the
// same card when it holds a row of side-by-side columns (a stepper's step names):
// at least the card width, growing to fit them (to a cap) so no column overflows
// into its neighbour.
export type PopoverWidth =
  | "content"
  | "fit"
  | "snug"
  | "anchor"
  | "anchor-min"
  | "menu-fit"
  | "menu"
  | "described"
  | "builder"
  | "picker"
  | "card"
  | "card-wide"
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "xl"
  | "2xl"
  | "3xl"
  | "4xl";
// `panel` is the theme's popover inset (density `popoverPad`, default the `md`
// step) and the default of `PopoverContent` / `OverlayPanel`: a call site that
// says nothing about padding is padded as its theme pads popovers. A named step
// is a call site's own decision (a menu's `xs`, a dialog's `lg`) and keeps it.
export type PopoverPadding =
  "none" | "2xs" | "xs" | "sm" | "md" | "lg" | "panel";

export const POPOVER_WIDTH: Record<PopoverWidth, string> = {
  content: "",
  fit: "w-max min-w-64 max-w-(--available-width)",
  snug: "w-max min-w-24 max-w-(--available-width)",
  anchor: "w-[var(--anchor-width,0px)] min-w-36",
  "anchor-min":
    "w-max min-w-[min(max(var(--popover-width-menu-min),var(--anchor-width,0px)),var(--available-width,100vw))] max-w-(--available-width)",
  "menu-fit":
    "w-max min-w-[min(var(--popover-width-menu-min),var(--available-width,100vw))] max-w-[min(var(--popover-width-menu-max),var(--available-width,100vw))]",
  // The four role widths are density tokens (`popoverWidth*`, defaults
  // 300px / 280px / 524px / 320px), so a theme sizes its menus and pickers.
  menu: "w-(--popover-width-menu-max) max-w-(--available-width)", // a control panel's list of choices
  described: "w-(--popover-width-described) max-w-(--available-width)", // choices with description lines
  builder: "w-(--popover-width-builder) max-w-(--available-width)", // a six-track rule row
  picker: "w-(--popover-width-picker) max-w-(--available-width)", // a panel whose body is a grid
  card: "w-(--popover-width-card) max-w-(--available-width)", // a hover card describing one thing
  "card-wide":
    "w-max min-w-[min(var(--popover-width-card),var(--available-width,100vw))] max-w-[min(28rem,var(--available-width,100vw))]", // a hover card holding side-by-side columns
  xs: "w-48 max-w-(--available-width)",
  sm: "w-56 max-w-(--available-width)",
  md: "w-64 max-w-(--available-width)",
  lg: "w-72 max-w-(--available-width)",
  xl: "w-80 max-w-(--available-width)",
  "2xl": "w-96 max-w-(--available-width)",
  "3xl": "w-[30rem] max-w-(--available-width)",
  "4xl": "w-[40rem] max-w-(--available-width)",
};

// A padding role is ONE `rail-<step>` class, not a padding class plus a
// hand-written co-publication of its value. Applying an inset IS opening a region
// (the rail contract, in app.css): `rail-<step>` pads AND publishes the four
// `--rail-*` vars in the same declaration, so the number exists exactly once and a
// descendant can read the panel's real inset. The pair that used to be spelled
// `p-<step> [--scroll-pad:…]` here is now a property of the shared contract rather
// than of this file.
//
// The reason the value must be readable to CSS is unchanged. `scroll-fade`
// (app.css) is the one consumer today: its sticky edge strips resolve their insets
// against the panel's CONTENT box, so without the value they park `padding-block`
// short of the panel's inner edges — and scrolled content, which does pass through
// that padding strip, re-emerges UNFADED there. It now reads `--rail-block-start` /
// `--rail-block-end` per edge, which is strictly better than the single
// `--scroll-pad` it replaced: one value for both edges was silently wrong the
// moment a role's block padding stopped being symmetric.
//
// Every step publishes, `none` included: custom properties INHERIT, so a `none`
// panel whose class published nothing would pick up an ENCLOSING panel's inset and
// offset its fade past its own edge. `rail-none` publishes zeros like every other
// step, so that hole cannot be reopened one role at a time.
export const POPOVER_PADDING: Record<PopoverPadding, string> = {
  none: "rail-none",
  "2xs": "rail-2xs",
  xs: "rail-xs",
  sm: "rail-sm",
  md: "rail-md",
  lg: "rail-lg",
  panel: "rail-panel",
};

// Max-height is its own axis, co-located with width/padding. The contract in one
// line: THE PANEL ALWAYS FITS THE VIEWPORT, AND THE ROLE IS A COMFORT CAP ON TOP
// OF THAT. `--available-height` — the space Floating UI measured between the
// anchor and the collision boundary (published by base-ui's Positioner, and by
// `FloatingSurface`'s own `size` middleware) — is the floor every role shares;
// `viewport` is that floor alone, and a named role only ever makes the panel
// SHORTER than the space it has, never taller. There is no opt-out: a panel that
// outgrows the viewport with no clamp puts its tail permanently out of reach,
// which is the entire bug class this axis exists to prevent.
//
// Three details that are load-bearing, not cosmetic:
//
//   - ONE `max-h` class per role — a clamp, never a clamp PLUS a cap. Two classes
//     in the same tailwind-merge group only compose correctly while nobody
//     touches their order; `min(cap, var(--available-height))` folds both into a
//     single class, so a caller's `className` override still resolves cleanly.
//   - The `100vh` IN-VAR fallback is required, not defensive. `--available-height`
//     does not exist until Floating UI's `size.apply` has run once, and an
//     undefined var invalidates the WHOLE `min()` at computed-value time →
//     `max-height: none` → one full-height frame on first paint.
//   - `overflow-y-auto` deliberately does NOT live here. Scrolling is an
//     unconditional invariant of the panel — owned by `OverlayPanel` (and the
//     `PopoverContent` / `FloatingSurface` roots it backs) — not something a role
//     can switch off. A clamp without a scroller is exactly the unreachable tail
//     again, so the two must never be separable at a call site.

export type PopoverMaxHeight = "viewport" | "sm" | "md" | "lg" | "xl";
export const POPOVER_MAX_HEIGHT: Record<PopoverMaxHeight, string> = {
  viewport: "max-h-[var(--available-height,100vh)]",
  sm: "max-h-[min(12rem,var(--available-height,100vh))]",
  md: "max-h-[min(16rem,var(--available-height,100vh))]",
  lg: "max-h-[min(20rem,var(--available-height,100vh))]",
  xl: "max-h-[min(24rem,var(--available-height,100vh))]",
};
