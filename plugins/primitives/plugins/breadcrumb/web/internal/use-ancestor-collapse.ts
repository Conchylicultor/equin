import { useRef, useState, type RefObject } from "react";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { planFold } from "./fold-plan";

/** Marks a visible ancestor crumb with its index in the trail. */
export const CRUMB_INDEX_ATTR = "data-crumb-index";
/** Marks the overflow crumb the folded ancestors live behind. */
export const CRUMB_FOLD_ATTR = "data-crumb-fold";

/** Each ancestor's last seen width, and the trail they were measured on. */
interface SeenWidths {
  trailKey: string;
  widths: (number | undefined)[];
  foldUnit: number | undefined;
}

export interface AncestorCollapseInput {
  /** The trail itself. It takes the row's slack, so its width IS the room. */
  rootRef: RefObject<HTMLElement | null>;
  /** The ancestor run — the overflow crumb (when folded) and the visible crumbs. */
  prefixRef: RefObject<HTMLElement | null>;
  /** The current page's label, the one leaf allowed to truncate. */
  leafRef: RefObject<HTMLElement | null>;
  /** Identity of the trail being shown; a new one re-decides from scratch. */
  trailKey: string;
  /** How many ancestors the trail has (0 for a root page: nothing to fold). */
  count: number;
}

/**
 * Decides how many leading ancestors are folded behind an overflow crumb.
 *
 * **The promise this exists to keep: the page's own name is never the thing
 * that gets cut.** The ancestors are secondary — they can leave the row and
 * still be one click away — while the leaf is the answer to "what am I looking
 * at", so it is the last thing to give, not the first. And they leave **one at
 * a time, oldest first**: the ones nearest the page say the most about it, so
 * they stay as long as there is room for them (`… › c › d › leaf`, never `… › leaf`
 * with the room for `c › d` standing empty).
 *
 * Measurements read off the real rendered boxes (`planFold` decides):
 *
 * - **Fold** when the leaf has started truncating (`scrollWidth > clientWidth`):
 *   the visible ancestors are rigid, so the leaf is the only cell flex can take
 *   room from — its truncation IS the row reporting that it is over-full. The
 *   oldest visible ancestors fold until their width covers the cut.
 * - **Unfold** when the row's trailing slack covers the nearest folded
 *   ancestor's last seen width, plus a margin — repeated while it does.
 *
 * Each ancestor's width is the distance from its crumb to the next crumb (or
 * the leaf), so it carries its separator and gaps; the overflow crumb's the
 * same way. They are **stamped with the trail they were measured on**, so a new
 * trail cannot be judged against the last one's numbers — a folded ancestor
 * never seen on this trail shows them all, and the next pass folds again what
 * does not fit.
 *
 * **It re-decides whenever any input moves, not only the room.** It observes
 * the trail, the ancestor run AND the leaf: the decision reads all three, and
 * each can change size with the trail's own width standing still — a web font
 * landing after the first measure, a theme's type step, the separator variant
 * arriving with a deferred plugin tier, a label re-rendering. Watching the
 * trail alone left a fold taken on such a transient in place for good.
 * Observing the leaf cannot loop: an ancestor only comes back when its cached
 * width says it fits, and a stale cache is corrected by the pass it triggers.
 *
 * **Every width is in layout pixels.** The widths are cached across frames,
 * so they must not depend on a CSS transform that can change between them (a
 * scaled exhibit or canvas frame zooming): visual widths from
 * `getBoundingClientRect` are divided back by the trail's own scale, the same
 * space `scrollWidth` / `clientWidth` already report in.
 *
 * **What it needs from the layout**: the trail must be given a definite width
 * (it takes the row's slack, so it is, wherever the row itself has one). Inside
 * a parent that shrink-wraps its content instead, the room around the trail is
 * invisible to it — it never mis-folds, it just doesn't notice new room.
 */
export function useAncestorCollapse({
  rootRef,
  prefixRef,
  leafRef,
  trailKey,
  count,
}: AncestorCollapseInput): number {
  const [hidden, setHidden] = useState(0);
  const seen = useRef<SeenWidths | null>(null);

  useResizeObserver(
    [rootRef, prefixRef, leafRef],
    () => {
      const root = rootRef.current;
      const leaf = leafRef.current;
      const prefix = prefixRef.current;
      if (root === null || leaf === null || prefix === null || count === 0) {
        return;
      }
      const rootRect = root.getBoundingClientRect();
      // Visual px per layout px (a CSS transform on an ancestor); 1 when the
      // trail is not laid out at all, so nothing divides by zero.
      const scale =
        root.offsetWidth > 0 && rootRect.width > 0
          ? rootRect.width / root.offsetWidth
          : 1;
      const leftOf = (el: Element) => el.getBoundingClientRect().left / scale;

      if (seen.current === null || seen.current.trailKey !== trailKey) {
        seen.current = { trailKey, widths: [], foldUnit: undefined };
      }
      const record = seen.current;
      // The row in order: the overflow crumb (when folded), each visible
      // ancestor, then the leaf — each one's width runs to the next one's left.
      const fold = prefix.querySelector(`[${CRUMB_FOLD_ATTR}]`);
      const crumbs = Array.from(
        prefix.querySelectorAll<HTMLElement>(`[${CRUMB_INDEX_ATTR}]`),
      );
      const leftOfNext = (i: number) =>
        leftOf(i + 1 < crumbs.length ? crumbs[i + 1]! : leaf);
      crumbs.forEach((crumb, i) => {
        const index = Number(crumb.getAttribute(CRUMB_INDEX_ATTR));
        record.widths[index] = leftOfNext(i) - leftOf(crumb);
      });
      if (fold !== null) {
        record.foldUnit =
          leftOf(crumbs.length > 0 ? crumbs[0]! : leaf) - leftOf(fold);
      }

      // The row is left-packed, so its free space is what lies past its last
      // child's right edge.
      const last = root.lastElementChild;
      const free =
        last === null
          ? 0
          : (rootRect.right - last.getBoundingClientRect().right) / scale;
      const next = planFold({
        hidden: Math.min(hidden, count),
        count,
        deficit: leaf.scrollWidth - leaf.clientWidth,
        free,
        widths: record.widths,
        foldUnit: record.foldUnit,
      });
      if (next !== hidden) setHidden(next);
    },
    { deps: [trailKey, hidden, count] },
  );

  return Math.min(hidden, count);
}
