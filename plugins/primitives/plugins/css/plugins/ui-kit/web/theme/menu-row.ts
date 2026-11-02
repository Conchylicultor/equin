// THE MENU ROW — one visual definition for every menu row in the app: the
// dropdown's items and sub-trigger, `SelectItem`, and `ControlPanel.Row`. Every
// one of them composes these lists instead of spelling its own, so the menus
// match and cannot drift. A new menu-like row applies them too.
//
// Two halves, read together: these class lists (every overridable SINGLE
// property, each a class twMerge classifies, so a caller's `className` replaces
// exactly the one it names — `gap-lg` on a picker pill's row), and the
// `menu-row` / `menu-row-lit` utilities in `app.css` (the states: tone vars,
// checked, destructive, icon tone, and the highlighted paint). Geometry is
// global; every colour is a theme token, so each app draws the same shape in
// its own colours.
//
// The highlight is wired by each component to ITS state model, because there
// are three: base-ui's `data-highlighted` (and `data-popup-open` on a submenu's
// trigger), and a control-panel row's `:hover`. See `app.css` for why that is a
// variant on one utility rather than a selector list ui-kit would have to keep
// in step with control-panel's DOM.

/**
 * The row's PAINT: state layer, type role (`label`: size, line-height, medium
 * weight) and resting text colour. Shared by every menu row, the control-panel
 * row included — which keeps its own subgrid geometry (`cp-row`) and so takes
 * the paint alone.
 */
export const MENU_ROW_PAINT =
  "menu-row text-label text-subtle-foreground [&_svg:not([class*='size-'])]:icon-auto";

/**
 * A checked / selected row's label weight. The colour lives in `menu-row`
 * (it keys on the row's own state attribute); the weight cannot, since a
 * utility may set no type metric that is not a role. Matches the same three
 * states, a switch excluded (its on state is a toggle, not a choice).
 *
 * Arbitrary `[&[data-…]]` variants, not `data-checked:`: this repo's
 * `data-checked` / `data-selected` variants wrap their selector in `:where()`,
 * which adds no specificity, so the weight would tie with `text-label`'s and
 * lose on stylesheet order. `.x[data-checked]` outranks the role by one step.
 */
export const MENU_ROW_CHECKED =
  "[&[data-checked]]:font-semibold [&[data-selected]]:font-semibold aria-checked:not-[[role=switch]]:font-semibold";

/**
 * The full row for a flex/grid menu item that owns its own geometry (the
 * dropdown's items, `SelectItem`): the paint, the checked weight, then height
 * (`--panel-row-h`, the same as a control-panel row), inline inset
 * (`--pad-row-x`), block inset (`xs`, which only a row taller than its
 * floor — a described choice — ever shows), icon↔label gap (`sm`), corners
 * (`--radius-panel-row`) and the disabled treatment. The component appends its own highlight variant.
 * Names itself `group/menu-row`, so a part of the row (the trailing action)
 * reveals on the row's own highlight: `group-data-highlighted/menu-row:…`.
 */
export const MENU_ROW = `${MENU_ROW_PAINT} ${MENU_ROW_CHECKED} group/menu-row w-full min-h-panel-row px-row py-xs gap-sm rounded-panel-row cursor-default select-none outline-hidden data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0`;

/** A section label over a run of rows: faint, caption role, semibold, sentence case. */
export const MENU_LABEL_PAINT =
  "text-caption font-semibold text-faint-foreground";

/** The section label as a menu draws it, on the rows' own inline inset. */
export const MENU_LABEL = `${MENU_LABEL_PAINT} px-row py-xs`;

/**
 * A row's trailing value or keyboard shortcut: faint caption, plain text — no
 * badge and no fill.
 */
export const MENU_VALUE = "text-caption text-faint-foreground";

/**
 * A row's trailing cluster — its action, shortcut and check mark, in that
 * order — pushed to the row's end (`ml-auto`; a grid row's last track needs
 * none). One class list so the dropdown's items and its sub-trigger end alike.
 */
export const MENU_ROW_TRAIL = "ml-auto flex shrink-0 items-center gap-xs";

/**
 * The hairline between runs of rows. `rail-bleed` spans it through the panel's
 * own rail, whatever padding role the panel is on.
 */
export const MENU_SEPARATOR = "rail-bleed my-menu-separator h-px bg-border";
