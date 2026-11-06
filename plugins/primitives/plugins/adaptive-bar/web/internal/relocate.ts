import { planMoves } from "@plugins/primitives/plugins/adaptive-bar/core";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/**
 * Moving one DOM node without destroying what lives inside it.
 *
 * Every re-parent is destructive in ways React cannot see and cannot restore:
 * it releases pointer capture, drops an open popover out of the top layer,
 * resets inner scroll offsets, restarts CSS transitions, blows away focus, and
 * — the one genuinely unrecoverable case — reloads an `<iframe>`.
 *
 * `moveBefore` (the state-preserving move) fixes all of that at once. It is not
 * everywhere yet, and `tauri/` ships WebKit on macOS, so everything below is
 * written twice: the cheap correct path, and the fallback that repairs by hand
 * what it can and REFUSES the case it cannot.
 */

/** The state-preserving move, as a capability of one parent element. */
interface MoveBeforeCapable {
  moveBefore(node: Node, child: Node | null): void;
}

function asMoveBeforeCapable(parent: Element): MoveBeforeCapable | undefined {
  const candidate = parent as Element & Partial<MoveBeforeCapable>;
  return typeof candidate.moveBefore === "function"
    ? (candidate as MoveBeforeCapable)
    : undefined;
}

/**
 * Does this document support state-preserving moves at all?
 *
 * Probed on the prototype, not on a live parent, because the answer decides
 * whether an iframe-bearing item is relocatable — a question the bar must
 * answer BEFORE it plans a move, not while performing one.
 */
export function supportsStatePreservingMove(): boolean {
  return (
    typeof Element !== "undefined" &&
    typeof (Element.prototype as Partial<MoveBeforeCapable>).moveBefore ===
      "function"
  );
}

/** Does this container hold something a plain re-parent would destroy outright? */
export function holdsIframe(container: Element): boolean {
  return container.querySelector("iframe") !== null;
}

/** One element's scroll position, and how to put it back. */
interface ScrollShot {
  el: Element;
  top: number;
  left: number;
}

/**
 * Snapshot everything a plain `insertBefore` is about to lose and hand back the
 * repair.
 *
 * Only focus and scroll offsets are recoverable. Pointer capture, the top
 * layer, `:hover` and running transitions are not — which is why the locks that
 * keep an item still during a drag or an open popover are mandatory rather than
 * a nicety, and why nothing inside a bar item may be `position: sticky`.
 */
function snapshotFragileState(container: Element): () => void {
  const active = document.activeElement;
  const focused =
    active instanceof HTMLElement && container.contains(active) ? active : null;

  // Only NON-ZERO offsets are worth restoring: a zero is where a reset lands
  // anyway, so recording it would just be work.
  const scrolls: ScrollShot[] = [];
  const walk = (el: Element): void => {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      scrolls.push({ el, top: el.scrollTop, left: el.scrollLeft });
    }
    for (const child of el.children) walk(child);
  };
  walk(container);

  return () => {
    for (const shot of scrolls) {
      // Not a scroll GESTURE — the auto-scroll / scroll-reveal primitives own
      // those, and neither models this: the offset is not being changed, it is
      // being put back where the browser just threw it away. There is nothing to
      // animate, nothing to stick to, and no element to reveal.
      // eslint-disable-next-line scroll-safety/no-adhoc-scroll-write -- restoring an offset a re-parent destroyed, not driving a scroll; `moveBefore` makes this whole branch dead where it exists
      shot.el.scrollTop = shot.top;
      // eslint-disable-next-line scroll-safety/no-adhoc-scroll-write -- see above
      shot.el.scrollLeft = shot.left;
    }
    // `preventScroll` because the refocus is repair, not navigation: scrolling
    // an ancestor to reveal the node would move the page under a user who never
    // asked for it.
    focusElement(focused, { reveal: false });
  };
}

/**
 * Put `node` immediately before `before` inside `parent` (append when `before`
 * is `null`), preserving as much as this browser allows.
 *
 * `moveBefore` throws a `HierarchyRequestError` when either end is disconnected,
 * which is exactly the state a container is in on the very first pass — it was
 * created in a `useState` initializer and has never had a parent. That case
 * loses nothing (there is no live state in a node that has never been
 * displayed), so it takes the plain path.
 */
export function relocateNode(
  parent: Element,
  node: Element,
  before: Node | null,
): void {
  const capable =
    node.isConnected && parent.isConnected
      ? asMoveBeforeCapable(parent)
      : undefined;
  if (capable !== undefined) {
    capable.moveBefore(node, before);
    return;
  }
  const restore = snapshotFragileState(node);
  parent.insertBefore(node, before);
  restore();
}

/**
 * Is this container docked at its own anchor right now?
 *
 * **The one statement of "in the row"**, and it names the anchor rather than the
 * bar root on purpose. The root was an assumption — that the anchor is a direct
 * child of it — and the assumption is false for every host that renders its
 * items through a slot: between the bar and a contribution sit `slot-render`'s
 * box and reorder's two wrappers, all three `display: contents` outside edit
 * mode. `display: contents` removes a box from LAYOUT but not from the DOM
 * TREE, so the anchor is two or three levels down while its container is still,
 * correctly, a flex item of the bar root.
 *
 * `nextSibling === anchor` already implies the two share a parent, so this is
 * the whole invariant and there is nothing else to compare.
 */
export function isDockedInline(container: Element, anchor: Element): boolean {
  return container.nextSibling === anchor;
}

/**
 * Place a still-in-the-row container immediately before its own anchor.
 *
 * The anchor is the zero-size marker React renders at the item's natural
 * position, so "before my anchor" IS the item's place in the author's order —
 * including whatever non-item children the host interleaved. That makes the
 * inline dock's ordering rule a per-item local check rather than a whole-row
 * diff, and the guard below is the property that matters: **a node already in
 * the right place is never touched**, so a resize that moves one widget leaves
 * the other six — their focus, their transitions, their scroll offsets — alone.
 *
 * **The anchor's own parent decides where the container goes** — see
 * {@link isDockedInline}. Docking into the bar root instead would throw the
 * moment a host put anything at all between itself and its items, which is what
 * `.Render` does for every one of them.
 */
export function dockInline(container: Element, anchor: Element): boolean {
  if (isDockedInline(container, anchor)) return false;
  const parent = anchor.parentElement;
  if (parent === null) {
    // Never reached from the bar, which finds its anchors by querying its own
    // subtree — so an anchor with no parent means a caller invented one, and a
    // silent skip would leave the occupant wherever it happened to be.
    throw new Error(
      "adaptive-bar: cannot dock an occupant against an anchor that has no parent",
    );
  }
  relocateNode(parent, container, anchor);
  return true;
}

/**
 * Reconcile a dock's children to exactly `wantIds`, in that order, with the
 * fewest moves.
 *
 * Used for the panel (and the parked bucket), where there are no anchors to
 * key off — the dock's whole content is the bar's to arrange. `planMoves` is an
 * LIS diff, so an unchanged order plans zero moves.
 *
 * **CALLER CONTRACT: strays must already be gone.** `planMoves` reads
 * `beforeId: null` as *append*, which is only the right place once every node
 * absent from `wantIds` has left this dock. The bar discharges that by running
 * the INLINE pass first: an occupant returning from the panel to the row is
 * pulled out by its own `dockInline`, so by the time this runs the dock holds
 * nothing it should not. Reversing the two passes would break the precondition,
 * not satisfy it.
 *
 * The `want.has(id)` filter below is therefore belt-and-braces rather than the
 * mechanism — it covers the one case the inline pass cannot, a host flipping
 * `overflow` at runtime so the eviction dock itself changes identity. It never
 * removes a stray here: every registered container appears in exactly one dock's
 * want list, so the pass that claims it pulls it out, and evicting it twice
 * would be a second pointless re-parent — a free way to lose focus.
 */
export function dockGroup(
  dock: Element,
  wantIds: readonly string[],
  containerOf: (id: string) => Element | undefined,
): number {
  const want = new Set(wantIds);
  const currentIds: string[] = [];
  for (const child of dock.children) {
    const id = child.getAttribute("data-adaptive-bar-item");
    if (id !== null && want.has(id)) currentIds.push(id);
  }

  const moves = planMoves(currentIds, [...wantIds]);
  for (const move of moves) {
    const node = containerOf(move.id);
    if (node === undefined) continue;
    const before = move.beforeId === null ? null : containerOf(move.beforeId);
    relocateNode(dock, node, before ?? null);
  }
  return moves.length;
}
