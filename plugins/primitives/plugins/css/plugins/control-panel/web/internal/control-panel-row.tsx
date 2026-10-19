import {
  cn,
  MENU_ROW_CHECKED,
  MENU_ROW_PAINT,
  MENU_VALUE,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CheckboxIndicator } from "@plugins/primitives/plugins/css/plugins/selection-indicator/web";
import { SwitchIndicator } from "@plugins/primitives/plugins/css/plugins/switch/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import type React from "react";
import { useCallback, useContext, useId } from "react";

import {
  dragIndicatorIcon,
  HANDLE_REVEAL,
  type ControlPanelHandleProps,
} from "./handle";
import { HintedLabelCell } from "./hint";
import { PanelStackContext, type PanelStackEntry } from "./stack-context";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const checkIcon = symbol("check");
const chevronRightIcon = symbol("chevron-right");

/** The three selection languages, one per meaning. There is no fourth. */
export type ControlPanelRowSelect = "check" | "radio" | "switch";
export type ControlPanelRowTone = "default" | "danger";

/**
 * How a row explains itself: a tooltip (`hint`) or a visible line
 * (`description`) — one or the other, never both, so a row cannot say the same
 * thing twice.
 */
type ControlPanelRowExplanation =
  | {
      /**
       * Explanatory prose as a TOOLTIP, wired by `aria-describedby` — never a
       * second line. A second line is the one change that breaks invariant #2 in
       * every panel at once; a muted pseudo-row breaks invariant #1's meaning (a row
       * that is not a control still opening the rails). See `HintedLabelCell`.
       */
      hint?: string;
      description?: never;
    }
  | {
      /**
       * Explanatory prose as a VISIBLE second line under the label — muted, wrapping,
       * and reserving its own height. Opt-in and the one sanctioned exception to
       * invariant #2 (one row height): a row that says what a choice MEANS before it
       * is picked (the page-kind menu, where each kind is a policy) cannot hide that
       * behind a tooltip the user has to discover. Everything else keeps `hint`.
       * A row takes one or the other, never both.
       */
      description: string;
      hint?: never;
    };

interface ControlPanelRowCommon {
  /** Shows the drag handle in the gutter track (revealed on row hover/focus). */
  handle?: boolean;
  /** dnd-kit listeners/attributes (and an activator `ref`) for that handle. */
  handleProps?: ControlPanelHandleProps;
  /**
   * Trailing cell content — a count, a type name, a chip. PRESENTATIONAL: it
   * carries no click target of its own. On a row with no `actions` that is a
   * hard contract (the row IS the click target, so an interactive control here
   * would be a nested one); on a row WITH `actions` the interactive trailing
   * content is the action cluster, and this still sits in front of it as plain
   * text. Ignored when `select="switch"`, which owns the cell.
   */
  trailing?: React.ReactNode;
  /**
   * Row actions — a hover-revealed cluster of `IconButton`s at the row's
   * trailing edge, rendered through the `row-actions` primitive.
   *
   * Passing it switches the row to its SECOND construction: the row box becomes
   * a non-interactive `<div>` and the selectable part becomes an inner subgrid
   * spanning every track but the trailing one, so the action buttons are the
   * click target's SIBLINGS rather than its descendants. See the component doc.
   */
  actions?: React.ReactNode;
  tone?: ControlPanelRowTone;
  /** Muted foreground — for a secondary row ("New field", "Add filter"). */
  muted?: boolean;
  /**
   * Select on PRESS without taking focus — for a panel opened beside a live
   * caret (the page editor's block menu), where a plain click would first
   * blur the editor and move its selection before the row's action runs. The
   * row selects on a primary-button `mousedown` (with `preventDefault`, so
   * focus stays where it is); keyboard activation (Enter / Space) still
   * selects.
   */
  keepFocus?: boolean;
  /**
   * Disables the row's SELECTION — not the whole row.
   *
   * On a row with no `actions` those are the same thing, and it reads as it
   * always has: the row is inert and dimmed. On a row WITH `actions` the
   * dimming and the inertness land on the inner select element only, and the
   * action cluster stays live. That is the honest meaning of the prop, and it is
   * the case that actually occurs: a saved preset whose fields have all left the
   * schema cannot be applied, but it is exactly the preset you want to delete.
   */
  disabled?: boolean;
  className?: string;
  /**
   * Forwarded to the row BOX — the outermost node — in both constructions, for
   * DnD / scroll-into-view. Deliberately not the inner select element on the
   * `actions` path: a ref that changed node the day a row grew an action would
   * hand a dnd transform a box that leaves the trailing cell behind.
   */
  ref?: React.Ref<HTMLElement>;
  children: React.ReactNode;
}

/**
 * What activating the row does — at most one of three, so a row cannot both
 * navigate and push. `push` is the panel-stack arm: the row opens a page of
 * the panel it sits in, and says so with a trailing `chevron-right` after its
 * value. Pushing through `push` rather than calling `usePanelStack().push` from
 * `onSelect` is what makes a drill row without its chevron unspellable.
 */
type ControlPanelRowTarget =
  | {
      /** Makes the row a `<button>`. */
      onSelect?: () => void;
      /** Makes the row an `<a>`. */
      href?: string;
      push?: never;
    }
  | {
      /**
       * Makes the row a `<button>` that pushes this page onto the enclosing
       * panel stack (`ControlPanel.Stack`, which every `ControlPanelPopover`
       * and `ControlPanelPane` mounts), with a trailing chevron. Throws when
       * there is no stack — a drill row with nowhere to drill is a dead click.
       */
      push: PanelStackEntry;
      onSelect?: never;
      href?: never;
    };

/**
 * Where a check / radio row draws its mark. `leading` (default) puts it in the
 * icon cell, where it IS the row's icon. `trailing` moves it after the row's
 * value, so the leading cell is free for a real `icon` — a menu of kinds, each
 * with its own glyph, ticked at the end. Role and `aria-checked` are the same
 * either way; only the drawing moves.
 */
export type ControlPanelRowIndicator = "leading" | "trailing";

/**
 * `checked` is required the moment `select` is set, and `icon` is excluded from
 * exactly the two selections that OWN the leading cell. That is what makes the
 * settings panel's three stacked "on" languages — a filled checkbox, a
 * highlighted row with a leading ✓, and a raw select — a type error rather than
 * a review note.
 *
 * The switch is a third arm rather than a third exclusion, because its leading
 * cell is empty BY CONSTRUCTION: the indicator lives in the trailing cell (see
 * `trailingContent` below), so nothing there competes with an icon. Collapsing
 * it into the check/radio arm made an icon + switch row unspellable, and the one
 * surface that wanted one moved a real glyph into the label cell instead —
 * misaligning its text against every other row in the panel.
 *
 * `actions` is excluded from that same switch arm, and for the mirror-image
 * reason: the switch is drawn IN the trailing cell, so a cluster there would be
 * a second occupant of a cell that already has an owner — and a toggle sharing
 * its box with a trash button is a mis-click waiting to happen. Excluded at the
 * type level rather than dropped at render, the same way `icon` is.
 */
export type ControlPanelRowProps = ControlPanelRowExplanation &
  ControlPanelRowTarget &
  (
    | (ControlPanelRowCommon & {
        icon?: React.ReactNode;
        select?: never;
        checked?: never;
        indicator?: never;
        /**
         * "This is the current one" as a persistent FILL — the `--selected`
         * tier `css/row`'s `selected` paints, so a hover (`--hover-fill`) and
         * the current row read apart. For a single-choice list whose current
         * row needs no mark (a preset menu). Excluded from the check / radio /
         * switch arms: a row is current by fill OR by mark, never both.
         */
        selected?: boolean;
      })
    | (ControlPanelRowCommon & {
        select: "check" | "radio";
        checked: boolean;
        indicator?: "leading";
        icon?: never;
        selected?: never;
      })
    | (ControlPanelRowCommon & {
        select: "check" | "radio";
        checked: boolean;
        /** The mark moves to the trailing cell; the leading cell holds `icon`. */
        indicator: "trailing";
        icon?: React.ReactNode;
        selected?: never;
      })
    | (ControlPanelRowCommon & {
        select: "switch";
        checked: boolean;
        icon?: React.ReactNode;
        actions?: never;
        indicator?: never;
        selected?: never;
      })
  );

/**
 * A leading / trailing cell of a described (two-line) row: pinned to the top
 * and exactly one TITLE line tall (`h-lh` in the body type, the title's own —
 * restated on the trailing cell, whose value text is otherwise a caption), below the same `py-xs` the described label cell pads by — so the icon
 * and the mark centre on the title, not on the title and its description.
 */
const TITLE_LINE_CELL = "self-start box-content h-lh py-xs text-body";

/**
 * THE panel row. Four grid tracks — gutter | icon/indicator | label | trailing —
 * so every label in every panel starts at the same x whether or not this
 * particular row has an icon, and a long label truncates in its own column
 * instead of sliding under the trailing control.
 *
 * The two leading tracks are reserved only when the PANEL has something to put
 * in them, which is why each row marks its own occupants: `data-cp-handle` when
 * it hangs a drag handle, `data-cp-icon` when its leading cell is actually
 * occupied — an icon, a checkbox or a radio mark, never a switch (which is
 * drawn in the trailing cell). A panel with neither is a two-track grid, and
 * its rows sit flush against the panel's own content inset — no reserved
 * columns nothing paints in.
 * The scan is per PANEL, never per row: derive it per row and a row with an icon
 * would indent its label past a row without one, which is the conditional
 * leading cell invariant #1 exists to delete.
 *
 * It is its own grid rather than a composed `css/row`'s `Row` on purpose. `Row`
 * is a `<Line>`-based FLEX row whose `icon` is a leading flex child, so the
 * label's x depends on whether an icon is present — that IS the 12/14/20/38px
 * misalignment this vocabulary exists to remove, and flex has no track that
 * occupies width when empty. Adding a grid mode plus a panel-only geometry axis
 * to a primitive with 50+ call sites costs more than eight lines of duplicated
 * element inference. The two stay in step by sharing TOKENS (`--pad-row-x`,
 * `--control-height-md`, the surface-following hover fill), not code.
 *
 * The host element is INFERRED, never authored — `href` → `<a>`,
 * `onSelect`/`disabled` → `<button>`, else a plain `<div>`. Same rule as `Row`,
 * so an author learns it once.
 *
 * ## Two constructions, chosen by `actions`
 *
 * **Without `actions`** the inferred element IS the row box: one node carrying
 * `cp-row`, with the four cells as its direct children. That is the shape ~50
 * call sites render today, and it is the reason the trailing cell is
 * presentational — a `<button>` inside a `<button>` is invalid DOM.
 *
 * **With `actions`** the row splits, the same way `css/row`'s `Row` splits when
 * it is handed both a click target and an action cluster. The box is always a
 * non-interactive `<div>`, and the selectable part becomes an inner element
 * spanning every track but the last — so the action buttons are that element's
 * SIBLINGS rather than its descendants, which is the only construction in which
 * both are legal at once. The inner element is a CSS **subgrid**: the panel's
 * tracks pass straight through it, so the gutter, icon and label cells land on
 * exactly the rails they land on in the other construction and invariant #1
 * never learns that this row is built differently. `col-[1/-2]` is written
 * track-count agnostic because `cp-row` has 2/3/4-track templates depending on
 * what the PANEL occupies, and a hardcoded span would break in three of them.
 */
export function ControlPanelRow({
  icon,
  hint,
  description,
  select,
  checked,
  indicator = "leading",
  selected,
  handle,
  handleProps,
  trailing,
  actions,
  tone = "default",
  muted,
  keepFocus,
  disabled,
  onSelect: onSelectProp,
  href,
  push,
  className,
  ref,
  children,
}: ControlPanelRowProps) {
  const hintId = useId();
  // Read unconditionally (a hook), required only by a row that pushes.
  const stack = useContext(PanelStackContext);
  if (push !== undefined && stack === null) {
    throw new Error(
      `ControlPanel.Row "${push.title}": \`push\` requires a <ControlPanel.Stack> ` +
        "ancestor. Panels rendered through ControlPanelPopover or ControlPanelPane " +
        "already have one.",
    );
  }
  const onSelect = push !== undefined ? () => stack?.push(push) : onSelectProp;
  const isLink = href != null;
  const isButton = !isLink && (onSelect != null || disabled != null);
  const press = selectHandlers(onSelect, keepFocus);
  const interactive = isLink || isButton;
  const hasActions = actions != null;

  // One callback ref for three possible hosts. A `RefObject`'s `current` is
  // MUTABLE, so `RefObject<HTMLElement>` is not assignable to
  // `RefObject<HTMLAnchorElement>` — but a callback ref is, because parameters
  // are contravariant. Normalizing the caller's ref into one callback is what
  // lets the public prop stay honest (`Ref<HTMLElement>` — a row is an element,
  // not a fixed tag) with no cast at any branch. Same composition idiom as
  // `css/sticky/stack`'s item ref.
  const hostRef = useCallback(
    (el: HTMLElement | null) => {
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // Leading cell. A single-select row shows a CHECKMARK AND NOTHING ELSE — no
  // background fill, because a filled row already means hover, and a panel that
  // says "selected" one way and "hovered" the same way says neither.
  // A SWITCH FALLS THROUGH TO `icon`: it owns the TRAILING cell, so its leading
  // cell holds whatever the row itself carries — nothing, usually, or a real
  // glyph for a row that has one.
  // A TRAILING indicator leaves this cell to `icon`, like a switch does.
  const markLeads = indicator === "leading";
  const mark =
    select === "check" ? (
      <CheckboxIndicator checked={checked ?? false} />
    ) : select === "radio" ? (
      checked ? (
        <Icon icon={checkIcon} className="text-primary-text" />
      ) : null
    ) : null;
  const leading =
    (select === "check" || select === "radio") && markLeads ? mark : icon;

  // …and the occupancy mark follows the CELL, not the row's props. A switch
  // reserves nothing here (it is drawn in the trailing cell), so a panel whose
  // only selections are switches has no icon column at all — before this it
  // reserved 18px that painted nothing and indented every label in the panel by
  // 26px, which is what the fx-toggle and metronome panels looked like.
  // NOT `leading != null`, deliberately: an UNCHECKED radio renders nothing yet
  // still owns the column — its mark is state, the track is not — so deriving
  // the marker from the rendered node would make the whole panel re-flow the
  // first time someone ticked a row.
  const occupiesLeadingCell =
    icon != null || ((select === "check" || select === "radio") && markLeads);

  // Trailing, in reading order: the value, then — on a row that ticks at the
  // end — the mark, then — on a row that pushes — the chevron, last because it
  // says where the whole row goes. An unticked trailing mark keeps its box
  // (`invisible`, the radio drawing nothing is STATE, not layout), so ticking
  // a row never moves its value.
  const trailingMark =
    (select === "check" || select === "radio") && !markLeads ? (
      select === "radio" ? (
        <Icon
          icon={checkIcon}
          className={cn("size-3.5 text-primary-text", !checked && "invisible")}
        />
      ) : (
        mark
      )
    ) : null;
  const trailingContent =
    select === "switch" ? (
      <SwitchIndicator checked={checked ?? false} disabled={disabled} />
    ) : (
      <>
        {trailing}
        {trailingMark}
        {push !== undefined ? (
          <Icon icon={chevronRightIcon} className="size-3.5" />
        ) : null}
      </>
    );
  // A row with a visible description is two lines tall: its leading and
  // trailing cells sit on the TITLE line rather than centring on the pair.
  const described = description !== undefined;

  const rowClass = cn(
    "group/cp-row cp-row transition-colors",
    // The shared menu row's paint (ui-kit `theme/menu-row.ts`): type role,
    // resting colour, icon tone, checked label, and — through `data-variant`
    // below — the destructive tone. The geometry stays `cp-row`'s own subgrid.
    MENU_ROW_PAINT,
    MENU_ROW_CHECKED,
    muted && "text-muted-foreground",
    // This row's highlight states are `:hover` and KEYBOARD focus; the paint is
    // the shared one — so a row reached by Tab or arrow lights exactly like a
    // dropdown row under the arrow keys, one indicator in every menu rather
    // than a fill in one surface and a ring in the other.
    // A `selected` row keeps its own fill under the pointer: the current row
    // never reads as merely hovered.
    selected
      ? "bg-selected text-accent-foreground"
      : interactive && "hover:menu-row-lit",
    // WHO is focused differs between the two constructions, and each spelling
    // is inert on the other path. `focus-visible:` is the box itself, which a
    // `<div>` box can never satisfy; the `has-[…]` form is the select element —
    // a direct child — so keyboard focus on the SELECTION lights the whole row,
    // while focus on an action button inside the cluster rings only that button
    // (its own `focus-ring`). Lighting on `:focus-within` would light the row
    // for the button too: two indicators for one focus.
    interactive &&
      (hasActions
        ? "has-[>[data-focus-ring]:focus-visible]:menu-row-lit"
        : "outline-none focus-visible:menu-row-lit"),
    // The actions cluster brings its OWN hover group rather than piggybacking
    // on `group/cp-row`, so the trailing cluster reveals only when this class is
    // on the row it belongs to. Same construction as `RuleRow` and `SettingRow`.
    hasActions && rowActionsAnchor,
    // Only the no-actions construction dims and deadens the WHOLE row: with
    // actions, `disabled` scopes to the selection (see the prop doc) and the
    // treatment moves onto the inner select element below.
    !hasActions && disabled && "pointer-events-none opacity-50",
    className,
  );

  // A selection row reports its OWN state. Plain `checkbox`/`radio`/`switch`
  // rather than `menuitemcheckbox`/`menuitemradio`: those require a
  // `role="menu"` ancestor, and a control panel is a labelled group of sections,
  // not a menu. Only the interactive hosts carry it — a display-only `<div>` row
  // showing an indicator is not a control.
  const selection: SelectionAttrs | undefined = select
    ? { role: SELECT_ROLE[select], "aria-checked": checked ?? false }
    : selected
      ? { "aria-current": "true" }
      : undefined;

  // The danger tone is the shared menu row's destructive tone, keyed on the
  // same attribute a dropdown item carries, so its text, icons and highlight
  // follow from `menu-row` rather than from classes restated here.
  const toneAttr =
    tone === "danger" ? { "data-variant": "destructive" } : undefined;

  // A visible description wraps to the panel's width, so the row states the
  // `described` width need itself (`width-need.ts`): the surface it lands in
  // widens to that bucket without the opener having to know it holds one.
  const needsAttr = described ? { "data-cp-needs": "described" } : undefined;

  // The description hangs off the HOST, so assistive tech reads the row's name
  // and then its hint. The node it points at is a zero-box `sr-only` sibling
  // inside the label cell, which is why the hint opens no track.
  const describedBy =
    hint !== undefined || description !== undefined
      ? { "aria-describedby": hintId }
      : undefined;

  // Each cell names itself (`data-cp-cell`), and the two LEADING cells also
  // declare whether they are OCCUPIED (`data-cp-handle` / `data-cp-icon`). The
  // occupancy marks are what `cp-panel` scans with `:has()` to decide whether
  // the panel reserves a gutter and an icon column at all — per panel, so every
  // row in it keeps one rail; the cell names are how the dropped cells are then
  // hidden, since an unhidden empty cell would auto-place into the track that
  // took its place. A check or radio indicator counts as an icon — it occupies
  // that column exactly as a glyph does — but a switch does not, because its
  // indicator is in the trailing cell.
  const leadingCells = (
    <>
      <span
        {...handleProps}
        data-cp-cell="gutter"
        data-cp-handle={handle ? "" : undefined}
        className={cn(
          "flex items-center justify-center text-muted-foreground",
          handle ? cn("cursor-grab", HANDLE_REVEAL) : "pointer-events-none",
          handleProps?.className,
        )}
      >
        {handle ? <Icon icon={dragIndicatorIcon} /> : null}
      </span>
      {/* Hidden from the accessibility tree: the indicator is a VISUAL restatement
          of `aria-checked`, and the icon is decorative — leaving them exposed
          would prefix the row's accessible name with the checkbox's own "✓". */}
      <span
        aria-hidden
        data-cp-cell="icon"
        data-cp-icon={occupiesLeadingCell ? "" : undefined}
        className={cn(
          "flex items-center justify-center",
          described && TITLE_LINE_CELL,
        )}
      >
        {leading}
      </span>
      <HintedLabelCell
        hint={hint}
        description={description}
        descriptionId={hintId}
      >
        {children}
      </HintedLabelCell>
    </>
  );

  const trailingCell = (
    <span
      data-cp-cell="trailing"
      className={cn(
        "flex items-center gap-2xs",
        MENU_VALUE,
        described && TITLE_LINE_CELL,
      )}
    >
      {trailingContent}
    </span>
  );

  // ── The actions construction ────────────────────────────────────────
  //
  // The box is a `<div>` whatever the row's props say, so the action buttons
  // have a legal place to live; the element the props DID infer moves inside it
  // as the selectable region. Everything that describes the SELECTION goes with
  // it — the role and `aria-checked`, the description, the disabled state, the
  // focus nomination — and everything that describes the ROW stays on the box.
  if (hasActions) {
    return (
      <div ref={hostRef} className={rowClass} {...toneAttr} {...needsAttr}>
        <SelectRegion
          href={href}
          onSelect={onSelect}
          press={press}
          disabled={disabled}
          isLink={isLink}
          isButton={isButton}
          selection={selection}
          described={describedBy}
        >
          {leadingCells}
        </SelectRegion>
        {/* `col-[-2/-1]` is the trailing track, named the same track-count
            agnostic way the select region names its span: `cp-row` is a 2-, 3-
            or 4-track grid depending on what the PANEL occupies, and only the
            end-relative line numbers are the same line in all three.

            `pin={null}` for the reason `RuleRow` gives: the track already
            reserves this space, so the cluster belongs IN FLOW; pinning it would
            float it over the label cell and paint a `--scrim` this row has no
            tint to publish. The cluster also supplies the xs control density and
            the click / pointerdown guards, so an action press never reaches the
            selection beside it. */}
        <span
          data-cp-cell="trailing"
          className={cn("col-[-2/-1] flex items-center gap-2xs", MENU_VALUE)}
        >
          {trailingContent}
          <RowActions pin={null}>{actions}</RowActions>
        </span>
      </div>
    );
  }

  // ── The plain construction ──────────────────────────────────────────
  //
  // Three concrete elements, not one `<Tag>` variable. A capitalized local
  // holding an element type reads to React Compiler as a component CREATED
  // during render (`react-hooks/static-components`) — its identity changes each
  // render, so React would remount the subtree and reset its state rather than
  // update it. Branching keeps the same inference rule (`href` → `<a>`,
  // `onSelect`/`disabled` → `<button>`, else `<div>`) with three stable element
  // types, and each host gets exactly the attributes it actually has.
  if (isLink) {
    return (
      <a
        href={href}
        ref={hostRef}
        onClick={onSelect}
        className={rowClass}
        {...toneAttr}
        {...needsAttr}
        {...selection}
        {...describedBy}
      >
        {leadingCells}
        {trailingCell}
      </a>
    );
  }
  if (isButton) {
    return (
      <button
        type="button"
        ref={hostRef}
        disabled={disabled}
        {...press}
        className={rowClass}
        {...toneAttr}
        {...needsAttr}
        {...selection}
        {...describedBy}
      >
        {leadingCells}
        {trailingCell}
      </button>
    );
  }
  return (
    <div
      ref={hostRef}
      className={rowClass}
      {...toneAttr}
      {...needsAttr}
      {...describedBy}
    >
      {leadingCells}
      {trailingCell}
    </div>
  );
}

/**
 * The selectable region of a row that carries `actions` — the element the row's
 * props inferred, rendered INSIDE the row box instead of as it.
 *
 * It is a subgrid, and that is the whole trick: `grid-cols-subgrid` makes the
 * panel's own tracks pass through this element unchanged, so the three cells it
 * holds land on exactly the rails they would as direct children of `cp-row`.
 * There is deliberately NO `gap` here — a subgrid inherits the parent grid's
 * column gap, and restating it is how the leading cells drift off the panel rail.
 *
 * `self-stretch` against the row's `align-items: center`, so the click target
 * fills the row's full `--cp-row-h` height rather than only its content's: an
 * inferred-height target would leave a few dead pixels above and below the label
 * that the un-split construction has never had.
 *
 * Three concrete elements again rather than one `<Tag>` local, for the reason
 * spelled out at the call site.
 */
function SelectRegion({
  href,
  onSelect,
  press,
  disabled,
  isLink,
  isButton,
  selection,
  described,
  children,
}: {
  href?: string;
  onSelect?: () => void;
  press: SelectHandlers;
  disabled?: boolean;
  isLink: boolean;
  isButton: boolean;
  selection: SelectionAttrs | undefined;
  described: DescribedAttrs | undefined;
  children: React.ReactNode;
}) {
  const className = cn(
    "grid grid-cols-subgrid col-[1/-2] self-stretch items-center min-w-0",
    // `outline-none`: the row BOX paints the focus (the lit fill, keyed on this
    // node's `:focus-visible`), so the UA outline would be a second indicator.
    "rounded-panel-row text-left outline-none",
    // The selection's state is reported HERE, not on the row box, so the
    // shared checked label (colour + weight) is applied here too.
    MENU_ROW_CHECKED,
    "aria-checked:not-[[role=switch]]:text-strong-foreground",
    // The disabled treatment, scoped to the selection. `pointer-events-none` as
    // well as the attribute, because a `<a>`/`<span>` region takes no `disabled`
    // — and the row box around it must stay live either way, so its actions
    // still work.
    disabled && "pointer-events-none opacity-50",
  );
  // Nominates this node as the one whose focus lights the box, written `=""` like
  // every other marker attribute in the repo — presence is the whole signal.
  const focus = { "data-focus-ring": "", "data-cp-select": "" };

  if (isLink) {
    return (
      <a
        href={href}
        onClick={onSelect}
        className={className}
        {...focus}
        {...selection}
        {...described}
      >
        {children}
      </a>
    );
  }
  if (isButton) {
    return (
      <button
        type="button"
        disabled={disabled}
        {...press}
        className={className}
        {...focus}
        {...selection}
        {...described}
      >
        {children}
      </button>
    );
  }
  return (
    <span className={className} {...focus} {...described}>
      {children}
    </span>
  );
}

/**
 * The two attribute bags the row computes once and then hands to whichever
 * element ends up being the selection — the row host on the plain path, the
 * inner region on the actions path. Named types rather than inferred ones so
 * both spreads typecheck as JSX attributes instead of as an index signature.
 */
type SelectionAttrs =
  | { role: "checkbox" | "radio" | "switch"; "aria-checked": boolean }
  | { "aria-current": "true" };
type DescribedAttrs = { "aria-describedby": string };

const SELECT_ROLE: Record<
  ControlPanelRowSelect,
  "checkbox" | "radio" | "switch"
> = {
  check: "checkbox",
  radio: "radio",
  switch: "switch",
};

type SelectHandlers = {
  onClick?: React.MouseEventHandler<HTMLElement>;
  onMouseDown?: React.MouseEventHandler<HTMLElement>;
};

/**
 * How a button row selects: on click, or — `keepFocus` — on a primary-button
 * press with the default prevented, so focus never leaves wherever it is. A
 * keyboard activation (Enter / Space) arrives as a `click` with `detail === 0`
 * and still selects; a pointer click (`detail > 0`) was already handled on
 * press, so it is not run twice.
 */
function selectHandlers(
  onSelect: (() => void) | undefined,
  keepFocus: boolean | undefined,
): SelectHandlers {
  if (!keepFocus) return { onClick: onSelect };
  return {
    onMouseDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      onSelect?.();
    },
    onClick: (e) => {
      if (e.detail === 0) onSelect?.();
    },
  };
}
