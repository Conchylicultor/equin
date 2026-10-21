import { useCallback, useImperativeHandle, useRef } from "react";
import {
  cn,
  useMenuSurface,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  RowActions,
  rowActionsAnchor,
} from "@plugins/primitives/plugins/row-actions/web";
import {
  splitPassthrough,
  type Passthrough,
} from "@plugins/primitives/plugins/passthrough/core";
import type React from "react";

export type RowSize = "sm" | "md";

/**
 * The row's focusable control, as a capability rather than a node. `Row` decides
 * WHICH element that is — the row box, or the inner button of the split path
 * below — and deliberately never says, so a holder can focus it and do nothing
 * else with it.
 */
export interface RowFocus {
  /** Move DOM focus onto the row's control. */
  focus(): void;
}

/** Write one node into a ref of either form (callback or object). */
function setRef(
  ref: React.Ref<HTMLElement> | undefined,
  el: HTMLElement | null,
) {
  if (typeof ref === "function") ref(el);
  else if (ref) ref.current = el;
}

/**
 * The attributes that describe the row's **control** — the `<button>`/`<a>` the
 * row infers — as opposed to the row as a node. `Row` routes these onto whichever
 * element it synthesized; everything else a caller spreads goes to the row BOX
 * (see the passthrough note on {@link RowProps}).
 *
 * This array is the ONE list: the runtime split reads it, and `RowControlProps`
 * is derived from it, so the type and the routing cannot drift into the classic
 * "these two must agree" hazard. `aria-*` is handled by prefix instead — on both
 * sides — so the aria family stays open with no list to maintain.
 *
 * Membership is decided by whose behaviour the attribute describes, and every
 * entry has a reason to be on the control specifically:
 * `onClick` because a `disabled` `<button>` must swallow it and Enter/Space only
 * synthesize a click on the button; `href`/`target`/`rel`/`download` because they
 * ARE the `<a>`; `role`/`tabIndex`/`autoFocus` and the keyboard/focus handlers
 * because the control is the focusable node (on the split path the box is a plain
 * `<div>` that cannot take focus at all). `onAuxClick`/`onMouseDown` travel with
 * `onClick` because together they are a link's gestures (`link-gesture`): on the
 * split path the box also wraps the row's actions, so a middle-click on an action
 * would otherwise open the row's link.
 */
const CONTROL_KEYS = [
  "onClick",
  "onAuxClick",
  "onMouseDown",
  "onKeyDown",
  "onKeyUp",
  "onFocus",
  "onBlur",
  "autoFocus",
  "href",
  "target",
  "rel",
  "download",
  "role",
  "tabIndex",
] as const;

const CONTROL_KEY_SET: ReadonlySet<string> = new Set(CONTROL_KEYS);

function isControlKey(key: string): boolean {
  return key.startsWith("aria-") || CONTROL_KEY_SET.has(key);
}

/**
 * Typed face of {@link CONTROL_KEYS}. Derived from the array rather than written
 * beside it, so adding a key to one adds it to the other.
 *
 * `aria-current` is deliberately absent: `Row` derives it from `selected`, and a
 * row that is "current" twice, from two sources, is a contradiction rather than a
 * feature. (If one arrives anyway through an untyped spread, `Row`'s own value
 * wins — it is written after the control bag.)
 */
export type RowControlProps = Pick<
  React.AnchorHTMLAttributes<HTMLElement>,
  (typeof CONTROL_KEYS)[number]
> &
  Omit<React.AriaAttributes, "aria-current">;

/**
 * `Row`'s passthrough ({@link Passthrough}) lands on the **row box** — the node
 * `ref` gives you — on BOTH paths, with ONE named exception:
 * {@link RowControlProps}, the closed set of attributes that describe the row's
 * CONTROL (`onClick`, the link attributes, `role`, `tabIndex`, the
 * keyboard/focus handlers, and any `aria-*`). Those `Row` routes onto whichever
 * node it synthesized, through `splitPassthrough` below.
 *
 * So the caller states MEANING and `Row` decides the node — the same move as
 * `focusRef` (a capability, not a node) and `className` (the treatment, owned by
 * the row).
 */
export interface RowProps extends RowControlProps, Passthrough {
  /** Persistent selection → bg-accent + text-accent-foreground; aria-current on buttons. */
  selected?: boolean;
  /** Text+gap density only; PADDING is always p-row. sm=text-xs gap-1.5, md=text-sm gap-2. Default "md". */
  size?: RowSize;
  /** Adds a `border` (bordered chip-rows). */
  bordered?: boolean;
  /** Tree depth px → style paddingLeft (overrides p-row's left). */
  indent?: number;
  /** Leading slot (icon / StatusDot / chevron), rendered before children. */
  icon?: React.ReactNode;
  /** Trailing slot, rendered through the `row-actions` primitive; hover-revealed by default. */
  actions?: React.ReactNode;
  actionsAlwaysVisible?: boolean;
  /**
   * The ROW ELEMENT — the row's outermost box, on both paths.
   *
   * Concretely, what {@link Passthrough} means by "never the node you focus":
   * on a row carrying `actions` the box is a plain `<div>` that cannot take
   * focus at all. Reach for `focusRef`, which hands out the capability instead
   * of the node.
   */
  ref?: React.Ref<HTMLElement>;
  /**
   * The capability to move focus onto the row's control — NOT that control's
   * node. A host that lands focus on a row programmatically (keyboard
   * navigation arriving at a void editor block) calls `focusRef.current.focus()`
   * and is told nothing else about the element it focused.
   *
   * Handing out the node is the bug this replaces. The control is SYNTHESIZED by
   * `Row`: it is the row box right up until the row carries `actions`, and from
   * that moment on it is an inner `<button>`/`<a>` rendered as a SIBLING of the
   * action cluster (nesting interactive elements is invalid DOM). So a caller
   * holding the node held one that changed identity the day someone added an
   * action, and the old `interactiveRef` — a second ref you had to know to reach
   * for — failed SILENTLY when you didn't: `.focus()` on an unfocusable `<div>`
   * neither throws nor focuses anything. A capability cannot be measured,
   * dragged, or compared against `document.activeElement`, so it cannot be
   * confused with `ref`, and `Row` stays free to move the focus target between
   * paths because that is now an internal detail.
   *
   * `focus()` is synchronous, and has to stay that way: the page editor's
   * `CaretSurface` contract is `focus: () => void` invoked imperatively from a
   * keydown handler, so a declarative `focused` prop would make the landing
   * async and break it. On a row that renders no control it THROWS — a
   * `focusRef` on a non-interactive row is a caller bug, and a loud one is
   * debuggable where the old silent no-op was not.
   */
  focusRef?: React.Ref<RowFocus>;
  disabled?: boolean;
  className?: string;
  title?: string;
  children: React.ReactNode;
  /**
   * Inline styles for the ROW BOX, merged under `indent` (which wins — it is the
   * row's own vocabulary for the same property). Declared rather than left to the
   * passthrough because it used to be spread AFTER the indent, so a caller's
   * `style` silently deleted a tree row's indentation.
   */
  style?: React.CSSProperties;
  /**
   * `Row` owns `type`, because it owns the element: it is `"button"` exactly when
   * the row infers a `<button>`, and absent otherwise. Spelled `never` so setting
   * it is a type error rather than a row that quietly became a submit button
   * inside someone's form.
   */
  type?: never;
}

export function Row({
  selected,
  size = "md",
  bordered,
  indent,
  icon,
  actions,
  actionsAlwaysVisible,
  ref,
  focusRef,
  disabled,
  className,
  style,
  children,
  ...rest
}: RowProps) {
  // ONE pass splits the passthrough by DESTINATION, which is the whole contract:
  // the routed bag goes to whichever node `Row` synthesized, the anchored one to
  // the row box — the node `ref` hands out — on BOTH paths. Nothing a caller
  // spreads changes node the day the row grows an `actions` slot.
  //
  // `splitPassthrough` is the split as a NAMED act (it lives in the passthrough
  // plugin, beside the contract it serves): saying out loud that a second
  // destination exists is what tells a deliberate routing apart from the
  // accidental one, both to a reader and to the lint rule. `isControlKey` stays
  // here — WHICH keys describe the control is `Row`'s own vocabulary.
  const { anchored: boxProps, routed: controlProps } = splitPassthrough(
    rest,
    isControlKey,
  );

  // The element is inferred, never authored: a row with `href` is a link, a row
  // with `onClick`/`disabled` is a button, anything else is a plain container.
  // This removes the `as` footgun — a clickable row can no longer be declared as
  // a `<button>` that then nests its `actions` buttons (invalid DOM). Inferred
  // FIRST because the focus handle below has to know whether this row renders a
  // control at all, and a hook cannot be moved past the conditional return.
  //
  // Read off `controlProps` rather than the raw passthrough: the two attributes
  // that DECIDE the element are by definition the control's own, so the split
  // that routes them is also the split that classifies them.
  const href = controlProps.href;
  const onClick = controlProps.onClick;
  const Tag: React.ElementType =
    href != null ? "a" : onClick != null || disabled != null ? "button" : "div";
  const isButton = Tag === "button";
  const interactive = Tag !== "div";

  // WHICH node takes the focus is `Row`'s business, so it keeps a private handle
  // on it — the row box itself on the single-element path, the inner
  // `<button>`/`<a>` on the split path — and publishes only the capability to
  // focus whatever that is (see `focusRef`).
  const controlRef = useRef<HTMLElement | null>(null);
  useImperativeHandle(
    focusRef,
    () => ({
      focus() {
        // A non-interactive row renders a plain `<div>`, and focusing it would
        // do nothing while looking like it worked — exactly how the ref this
        // replaces failed. So it throws instead: the caller either meant to make
        // the row clickable, or meant not to hold a `focusRef` at all.
        if (!interactive) {
          throw new Error(
            "Row: focusRef.focus() on a row that renders no focusable control. A Row " +
              "is only focusable when it infers one from its props (`href` → <a>, " +
              "`onClick`/`disabled` → <button>); with neither it is a plain <div>. Give " +
              "the row an `onClick`/`href`, or drop the `focusRef`.",
          );
        }
        // Unreachable-null: the handle is published by the same commit that
        // attaches the ref below, so anyone holding it holds a mounted row.
        controlRef.current?.focus();
      },
    }),
    [interactive],
  );

  // SINGLE-ELEMENT PATH refs — the one element is both the box and the control,
  // so the caller's `ref` and the private control handle collapse onto it.
  // Memoised on the caller's ref so React does not detach and re-attach it on
  // every render.
  const setBoxAndControl = useCallback(
    (el: HTMLElement | null) => {
      setRef(ref, el);
      controlRef.current = el;
    },
    [ref],
  );
  // SPLIT PATH — `ref` still goes to the box untouched, and the control handle
  // is written through a CALLBACK rather than a ref object handed straight to
  // `<Tag>`. `Tag` is an `ElementType`, so its `ref` prop types as the
  // INTERSECTION of every element it could be — a `Ref<HTMLElement>` satisfies
  // none of them, while a callback taking the supertype satisfies all of them.
  const setControl = useCallback((el: HTMLElement | null) => {
    controlRef.current = el;
  }, []);

  // The single-line contract (region-line + SingleLineProvider) comes from
  // <Line>; Row layers its interactive row chrome (width, padding, hover) on top.
  //
  // `rowActionsAnchor` is unconditional: it establishes the `group/row-actions`
  // hover group the actions cluster reveals off (a CSS group, so a hovered row
  // costs zero re-renders — the list and table views window 100+ rows), plus the
  // `relative` a pinned cluster anchors to. Both are inert on a row with no
  // actions, and pinning them to `actions ? …` would only make the row's
  // positioning context depend on which slots the caller filled.
  //
  // The two focus utilities are UNCONDITIONAL because each is inert on the path
  // where it cannot match, and a branch would only re-state the path split in a
  // second place. On the single-element path the box IS the control, so
  // `focus-ring` fires and `focus-ring-from`'s `:has(> …)` can never match (the
  // box is not its own child). On the split path the box is a `<div>` that can
  // never be focused, so `focus-ring` never fires and `focus-ring-from` picks up
  // the inner control's focus instead. Either way the ring is painted by the
  // BOX: one indicator, identical whether or not the row carries actions, and
  // covering the whole `p-row` padding ring that the control — a `flex-1` child
  // of an `items-center` line — can never reach. `focus-ring-within` is
  // deliberately not what this uses: it would also fire when a row ACTION takes
  // focus, stacking the row's ring on top of that button's own.
  // A row in a floating panel (a popover, a menu) is a PANEL row: its corners
  // are the shape group's `radiusPanelRow` — the same role a control-panel row
  // (`cp-row`) wears, defaulting to this `rounded-md` step — so a theme rounds
  // every row in its popovers at once.
  const onPanel = useMenuSurface();
  const chromeClass = cn(
    "group w-full p-row text-left transition-colors [&_svg:not([class*='size-'])]:icon-auto",
    onPanel ? "rounded-panel-row" : "rounded-md",
    "focus-ring focus-ring-from",
    rowActionsAnchor,
    "disabled:pointer-events-none disabled:opacity-50",
    size === "sm" && "gap-xs text-caption",
    size === "md" && "gap-sm text-body",
    // Each tint co-publishes itself as `--scrim` — the color the pinned action
    // cluster's mask paints so it hides the row instead of letting the label
    // show through the action icons. Same contract as a Surface publishing
    // `--chrome-mask`, one level down: the surface says what is behind the row,
    // the row says what is *painted* on it right now. A translucent tint
    // publishes its composite over the ambient mask, which is why this is a
    // second property and not a `--chrome-mask` re-declaration — a custom
    // property whose value reads itself is a cycle, and CSS drops it.
    // A selected row also takes the accent's own text colour, so its label
    // reads brighter than its neighbours' (a theme whose accent text equals its
    // body text sees no change). Leaves that set their own tone (a muted
    // subtitle, a finished row's dimmed title) keep it.
    // The hover is the SURFACE's, never the caller's: every surface publishes
    // `--hover-fill` (a card its muted tone, the sidebar its accent, a popover
    // its own `popoverHover`), so a row hovers to the right step above
    // whatever it sits on. There used to be a `hover="accent" | "muted"` prop
    // — a caller's guess at that surface — and a guess for one theme was wrong
    // in another (Mist's popover IS its muted tone, so a `muted` row in a menu
    // hovered to nothing).
    selected
      ? // The selected tier (`--selected`, default = the accent hover
        // fill), so a theme can set hover and selection apart.
        "bg-selected text-accent-foreground [--scrim:var(--selected)]"
      : "hover:bg-hover-fill hover:[--scrim:var(--hover-fill)]",
    bordered && "border",
    className,
  );
  // `indent` wins over a caller's `paddingLeft`: it is the row's OWN vocabulary
  // for that property (tree depth), so a `style` that could delete it would be a
  // silently un-indented tree. Merged rather than replaced, because the realistic
  // caller `style` is a dnd transform that has nothing to do with padding.
  const rowStyle =
    indent !== undefined ? { ...style, paddingLeft: indent } : style;

  // The trailing cluster is the `row-actions` primitive — the ONE implementation
  // of a row-action cluster, owning the reveal, the popup-hold, the click +
  // pointerdown guards (a press on an action must not fire the row's onClick nor
  // arm its drag source) and the control size. `Row` keeps only the PLACEMENT
  // decision, which is the one thing that genuinely differs per host:
  //
  // - Hover-revealed actions are PINNED to the right edge, so a hidden cluster
  //   reserves ZERO flow width — otherwise a multi-button cluster (e.g. a queue
  //   row's 4 icon buttons) permanently steals ~100px from the row body via
  //   `shrink-0`, collapsing the flex-1 title cell and truncating the title even
  //   when nothing is shown. On reveal the cluster overlays the row's right edge,
  //   which is why the pin's `mask` (owned by the primitive) is not optional: it
  //   paints the row's own `--scrim` under the buttons with a gradient ramp on
  //   its inner edge, so what the cluster covers (a trailing status badge, a long
  //   title) dissolves under it rather than interleaving its glyphs with the
  //   icons. Reserving the width instead would cure the overlap too, at the cost
  //   the paragraph above rejects.
  // - `actionsAlwaysVisible` actions instead stay in flow (`pin={null}`): they
  //   are part of the row layout and legitimately reserve their space, so the
  //   placement `Row` hands down is `ml-auto shrink-0` — flush right, never
  //   crushed.
  //
  // Either way they paint above the split path's `z-under` hit-area, so their
  // buttons stay clickable.
  const actionsCluster = actions ? (
    <RowActions
      pin={actionsAlwaysVisible ? null : "right"}
      alwaysVisible={actionsAlwaysVisible}
      className={actionsAlwaysVisible ? "ml-auto shrink-0" : undefined}
    >
      {actions}
    </RowActions>
  ) : null;

  // SPLIT PATH — an interactive row that also carries actions. The interactive
  // element must be a SIBLING of the actions, never their ancestor, so we render
  // a non-interactive container and put the primary <button>/<a> beside the
  // actions. A full-bleed, aria-hidden hit-area child keeps the whole padded row
  // clickable and gives the button its accessible name from {children}.
  //
  // The hit-area is sized to the CONTAINER (`inset-0` resolves against the
  // `relative` box, not the button), so it also covers the `p-row` padding ring
  // the button — a `flex-1` child of an `items-center` line — can never reach.
  //
  // It MUST paint below the row's own content (`z-under`), never above it.
  // Absolutely-positioned siblings paint over non-positioned ones regardless of
  // DOM order, so an on-top hit-area silently swallows every pointer event aimed
  // at the row body: hover-driven body content (a tooltip trigger, a CSS
  // `group-hover` chip) goes dead, because :hover only applies to the element
  // under the pointer and its ANCESTORS — and the hit-area is a sibling. Clicks
  // on the ring still land on it (nothing else is there to hit), so pushing it
  // under costs nothing. `isolate` is load-bearing: it makes the container a
  // stacking context, without which the negative layer escapes to the nearest
  // one up the tree and sinks behind intervening backgrounds.
  if (interactive && actions) {
    return (
      <Line
        as="div"
        ref={ref}
        className={cn(chromeClass, "isolate")}
        style={rowStyle}
        {...boxProps}
      >
        <Tag
          // The control bag is spread FIRST so every attribute below — the ones
          // `Row` owns because it owns the element — wins over a caller's. It
          // used to be `{...rest}` last, which let a passthrough quietly displace
          // `type`, `disabled` or the `aria-current` that `selected` derives.
          {...controlProps}
          ref={setControl}
          type={isButton ? "button" : undefined}
          disabled={isButton ? disabled : undefined}
          aria-current={isButton && selected ? true : undefined}
          // Nominates THIS node as the one whose focus rings the box
          // (`focus-ring-from` above). Written `=""` like the other marker
          // attributes in the repo — presence is the whole signal.
          data-focus-ring=""
          className={cn(
            // `outline-none`: the ring is painted by the box, so the UA outline
            // would be a second, tighter indicator hugging the label inside it.
            "flex min-w-0 flex-1 items-center text-left outline-none",
            size === "sm" ? "gap-xs" : "gap-sm",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {icon}
          {children}
          <span
            aria-hidden
            className={cn(
              "absolute inset-0 z-under",
              onPanel ? "rounded-panel-row" : "rounded-md",
            )}
          />
        </Tag>
        {actionsCluster}
      </Line>
    );
  }

  // SINGLE-ELEMENT PATH — no actions (any element), or a non-interactive
  // container row with actions (a <div> may legally nest the action buttons).
  // The positioning context a hover-revealed cluster pins against already comes
  // from `rowActionsAnchor` in `chromeClass`.
  return (
    <Line
      as={Tag}
      // Box and control are the SAME element here, so both bags land together and
      // the routing is a no-op — which is exactly the point: the destination rule
      // is one rule, stated once, and this path is the degenerate case of it
      // rather than a second contract. Both spread before the attributes `Row`
      // owns, so a passthrough can never displace them.
      {...boxProps}
      {...controlProps}
      ref={setBoxAndControl}
      type={isButton ? "button" : undefined}
      disabled={isButton ? disabled : undefined}
      aria-current={isButton && selected ? true : undefined}
      className={chromeClass}
      style={rowStyle}
    >
      {icon}
      {children}
      {actionsCluster}
    </Line>
  );
}
