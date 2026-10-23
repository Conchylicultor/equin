import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  cn,
  ControlSizeProvider,
  SURFACE_LEVELS,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  Pin,
  type PinAnchor,
} from "@plugins/primitives/plugins/css/plugins/pin/web";
import { PopupOpenScope } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import {
  insetClass,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";

/**
 * Apply to the row element whose **hover** should reveal its {@link RowActions}.
 * Establishes the `row-actions` hover group the cluster reacts to — the primitive
 * brings its **own** group rather than piggybacking on whatever group the row
 * already carries (e.g. the sidebar's `group/menu-item`), so it stays
 * group-name-agnostic. Hover is all this group carries: focus is scoped to the
 * cluster's own subtree instead (see `revealClasses`), so a click landing on
 * something inside the row cannot pin its actions. `relative` is included so a
 * pinned cluster anchors to this row; harmless on rows that are already
 * positioned.
 *
 * ```tsx
 * <SidebarMenuItem className={rowActionsAnchor}>
 *   <SidebarMenuButton>…</SidebarMenuButton>
 *   <RowActions>
 *     <IconButton icon={MdClose} label="Close" onClick={…} />
 *   </RowActions>
 * </SidebarMenuItem>
 * ```
 */
export const rowActionsAnchor = "group/row-actions relative";

/** The anchor's group class as a selector (`/` escaped), for finding the row a
 *  cluster reveals off. Spelled literally: jsdom has no `CSS.escape`. */
const ANCHOR_SELECTOR = ".group\\/row-actions";

/** What can take keyboard focus by itself — the question "can Tab land inside
 *  this row before it reaches the actions?". */
const FOCUS_STOP =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]';

/** The row-side signals that the user is reaching for this row: the pointer is
 *  on it (`pointerover` bubbles from every child; `pointermove` covers a row
 *  that mounted under a resting pointer, which gets no `over`), or focus
 *  entered it. */
const INTENT_EVENTS = ["pointerover", "pointermove", "focusin"] as const;

/**
 * Coupled opacity↔pointer-events reveal, keyed on the primitive's own
 * `group/row-actions`. Hidden is always BOTH `opacity-0` AND
 * `pointer-events-none`, so the invisible cluster never intercepts clicks on the
 * row beneath it. `select-none` is unconditional: action buttons are chrome, never
 * selectable content, so the cluster stays out of any text-selection range (Ctrl+A
 * or drag) over the row. Revealed on row hover, on keyboard focus INSIDE the
 * cluster, and — via `PopupOpenScope` below — while a popup launched from inside
 * the cluster is open, so an open menu never hangs off an invisible trigger.
 * Group names must be literal for Tailwind's JIT, so this lives as a static
 * string rather than an interpolated group.
 *
 * The focus half is `has-[:focus-visible]`, and both parts of that are
 * load-bearing:
 *
 * - **`has-[…]`, not `group-…/row-actions`**, asks the focus question about the
 *   CLUSTER rather than the row. `:has()` matches descendants only, and these
 *   classes ride the outermost node the primitive renders (the `Pin`, or the
 *   `Stack` when `pin={null}`), which contains exactly the action
 *   buttons — so nothing in the row body can satisfy it. Keying on the row is
 *   what pinned the cluster after an ordinary click: clicking a row puts focus
 *   somewhere inside it on every surface (a collapsible card's toggle, a
 *   `tabIndex={-1}` select-scope div, an inline file link, a tree chevron, the
 *   row's own primary button), so the actions stayed on screen after the pointer
 *   left.
 * - **`:focus-visible`, not `:focus`**, keeps the reveal keyboard-only. Chromium
 *   does not mark a mouse-clicked button as focus-visible, so clicking an action
 *   no longer pins its own cluster either; a Tab keypress always sets it, so
 *   keyboard reach is preserved. This is already the app's spelling for keyboard
 *   reach — see `tree/web/internal/tree-row-chrome.tsx:102`, the three
 *   `ui/tree-disclosure` variants, and workflows' sidebar label action.
 */
const revealClasses =
  "opacity-0 pointer-events-none select-none transition-opacity " +
  "group-hover/row-actions:opacity-100 group-hover/row-actions:pointer-events-auto " +
  "has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto";

interface RowActionsCommonProps {
  children: ReactNode;
  /** Keep the cluster always visible instead of revealing on row hover. */
  alwaysVisible?: boolean;
  /**
   * Placement classes for the host's OWN layout — `ml-auto`, `shrink-0`,
   * `justify-end`. The host owns WHERE the cluster sits in its row; the
   * primitive owns everything else about it. Merged (tailwind-merge) onto the
   * outermost node, which is also the node the reveal rides.
   */
  className?: string;
  /**
   * `"float"` — the cluster draws on its own small float-surface chip
   * (`SURFACE_LEVELS.float`: glass, outline, shadow), for a cluster that sits
   * over a picture rather than over its row's own text (a gallery card's
   * cover). The chip replaces the pinned scrim (there is no row tint under a
   * picture to dissolve into), and it **collapses when no control renders** in
   * it — an at-rest arm whose actions all rest elsewhere for this row draws
   * nothing, not an empty glass pill. Omitted ⇒ bare buttons (and, pinned, the
   * row's `--scrim`).
   */
  chrome?: "float";
}

/** The float chip: the float surface around the buttons, hidden while it
 *  holds no control. `:has()` asks for a control rather than for `:empty`,
 *  because a slot wraps each contribution in layout-neutral boxes that stay
 *  even when the contribution renders nothing. */
const FLOAT_CHIP = cn(
  SURFACE_LEVELS.float,
  "p-2xs not-has-[button,a[href],input]:hidden",
);

/**
 * `pin` and `float` are a discriminated pair, not two free booleans: a pinned
 * cluster is out of flow by definition, so only an UNPINNED cluster can take
 * part in a text flow, and the type is what says so.
 */
export type RowActionsProps = RowActionsCommonProps &
  (
    | {
        /** Where to pin the cluster relative to its `rowActionsAnchor` row.
         *  Defaults to the right edge (`"right"`). */
        pin?: PinAnchor;
        float?: never;
      }
    | {
        /** Render the cluster inline instead of absolutely positioning it —
         *  inside an existing trailing flex slot, or a reserved grid track. */
        pin: null;
        /** Float the cluster at the inline end of a text flow (a headerless
         *  transcript turn): the prose wraps around it instead of running under
         *  it. Its box is held whether or not it is revealed, so revealing it
         *  never reflows the text. Place it BEFORE the prose it sits beside. */
        float?: boolean;
      }
  );

/**
 * The hover-revealed action cluster for a list/tree/sidebar row. Holds one or
 * more `IconButton` (`primitives/icon-button`) — the cluster sizes them itself
 * via `ControlSizeProvider size="xs"`, so an action button is an ordinary
 * `IconButton` and this plugin has no button of its own. Anchor it inside a row
 * carrying {@link rowActionsAnchor}; the actions fade in on row hover (and on
 * keyboard focus reaching a button inside the cluster), with the
 * opacity↔pointer-events coupling owned here so a hidden action is never a live
 * click-target.
 *
 * Owning no button is what keeps this plugin BELOW `icon-button` in the plugin
 * graph, which is what lets `css/row` — a layout primitive — compose it. An
 * alias for "the button that goes in here" would drag `icon-button` (and
 * through it `action-presentation`) into every consumer of `Row`.
 *
 * The reveal is **opacity only** — the cluster is pinned, so it occupies no flow
 * width and its geometry is identical hovered or not. That is load-bearing, not
 * an optimization: a menu launched from inside the cluster anchors to it, so a
 * reveal that changed layout would slide the open menu sideways the moment the
 * pointer left the row.
 */
export function RowActions(props: RowActionsProps) {
  // Only a PINNED, hover-revealed cluster can wait: it is out of flow, so
  // whether its buttons exist changes no geometry. An in-flow cluster
  // (`pin={null}` — a table's reserved track) sizes its track by its content,
  // and an `alwaysVisible` one is on screen at rest.
  // A float chip (`chrome="float"`) sits over a picture, not in a track, so
  // it may wait too, pinned or not: nothing lays out around it.
  const deferrable =
    !props.alwaysVisible && (props.pin !== null || props.chrome === "float");
  const [sentinelRef, reached] = useRowReached(deferrable);
  if (deferrable && !reached) return <span ref={sentinelRef} hidden />;
  return <RowActionsCluster {...props} />;
}

/**
 * Has the user reached for the row this cluster sits in? A hover-revealed
 * cluster is invisible and inert until then, so mounting its buttons is
 * deferred to that moment: a list mounts N rows at once (a group unfolding, a
 * page of results), and each cluster is a handful of buttons with their
 * tooltips — the bulk of what a row costs to mount, for affordances nobody can
 * see yet.
 *
 * Reached means: the pointer is over the row (`:hover` already, or any of
 * {@link INTENT_EVENTS} on the anchor), or focus entered it. The focus half is
 * what keeps keyboard reach: Tab lands on the row's own control first, which
 * mounts the cluster just after it in the sequence. A row with NO focus stop of
 * its own (a plain container row) gives Tab nothing to land on before the
 * actions, so it is reached at once — exactly the eager cluster it always had.
 * So is a cluster with no anchor above it: nothing would ever arm it.
 *
 * Once reached, always reached: the cluster stays mounted (a popup opened from
 * it, a tooltip mid-fade), never torn down when the pointer leaves.
 */
function useRowReached(
  deferrable: boolean,
): [RefObject<HTMLSpanElement | null>, boolean] {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [reached, setReached] = useState(false);
  useLayoutEffect(() => {
    if (!deferrable || reached) return;
    const anchor = sentinelRef.current?.closest(ANCHOR_SELECTOR);
    if (
      !(anchor instanceof HTMLElement) ||
      anchor.matches(":hover") ||
      anchor.querySelector(FOCUS_STOP) === null
    ) {
      setReached(true);
      return;
    }
    const reach = () => setReached(true);
    for (const type of INTENT_EVENTS)
      anchor.addEventListener(type, reach, { passive: true });
    return () => {
      for (const type of INTENT_EVENTS) anchor.removeEventListener(type, reach);
    };
  }, [deferrable, reached]);
  return [sentinelRef, reached];
}

function RowActionsCluster({
  children,
  pin = "right",
  alwaysVisible = false,
  float = false,
  chrome,
  className: placement,
}: RowActionsProps) {
  const cluster = (className?: string) => (
    <Stack
      direction="row"
      gap="none"
      align="center"
      // Pressing an action must not reach the row: a click would fire the row's
      // own onSelect (navigating away from whatever the action just did), and a
      // pointerdown would arm a whole-row drag source (tree rows are dragged by
      // their body, with no grip handle). It sits on the BUTTON cluster, not on
      // the pin, so a click on the scrim's fade margin still falls through to
      // the row — that margin is row, not affordance.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(chrome === "float" && FLOAT_CHIP, className)}
    >
      <ControlSizeProvider size="xs">{children}</ControlSizeProvider>
    </Stack>
  );
  // `mask` paints the row's own `--scrim` under the cluster with a gradient ramp
  // on its inner edge: a pinned cluster overlays whatever the row already renders
  // there (a trailing badge, a long label), and without the scrim the two sets of
  // glyphs interleave. An `alwaysVisible` cluster is still pinned by the caller's
  // choice of `pin`, so it needs the scrim just as much.
  //
  // The reveal therefore rides the OUTERMOST node — the pin, when there is one.
  // The scrim is opaque, so a cluster that faded while its own backdrop stayed
  // painted would hide the row's trailing content at rest instead of only while
  // revealed, and the backdrop would sit over the row as a live click-target.
  return (
    <PopupOpenScope>
      {(popupOpen) => {
        const reveal = alwaysVisible
          ? undefined
          : // `cn` (tailwind-merge), not concatenation: the held state must WIN
            // over `opacity-0`, and merge order is what decides that.
            cn(revealClasses, popupOpen && "opacity-100 pointer-events-auto");
        // The outermost node carries both the reveal and the host's placement
        // classes, for the same reason: it is the one node that exists in every
        // configuration, so neither can end up on an inner node that fades or
        // moves independently of the box the user actually sees.
        const outer = cn(reveal, placement);
        if (pin !== null) {
          // A float chip brings its own backdrop, so the pin paints no scrim.
          return (
            <Pin
              to={pin}
              offset="xs"
              mask={chrome !== "float"}
              className={outer}
            >
              {cluster()}
            </Pin>
          );
        }
        // Floated: the float and its start gutter ride the outermost node with
        // the reveal, so the held box and the visible buttons are the same box.
        // `h-lh`: the float is exactly ONE text line tall, its buttons centred
        // on it (taller xs buttons overflow it symmetrically). Any taller and
        // the buttons sit below the first line's centre, and the second line
        // wraps around the float too — the cluster reads as spanning two rows.
        return cluster(
          float
            ? cn("float-right h-lh", insetClass({ l: "sm" }), outer)
            : outer,
        );
      }}
    </PopupOpenScope>
  );
}
