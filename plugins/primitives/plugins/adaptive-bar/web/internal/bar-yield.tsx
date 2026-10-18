import {
  useContext,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { fillClasses } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { BarRegistryContext } from "./registry";
import { rendersNothing } from "./presence";

/**
 * The yielding cell's floor, in multiples of its own font size: the width below
 * which it stops giving and the row is judged to have overflowed.
 *
 * **Why there is a floor at all.** Without one this cell gives until it is
 * nothing, and it gives FIRST — the occupants are rigid, so flex takes the whole
 * deficit out of the one child that can shrink. The row therefore never
 * overflows, the fit is never asked to demote or relocate anybody, and the pane
 * title is the first and total casualty of a busy header: "Une Sorcière Comme
 * Les Autres" renders as "Une" at 1400px and disappears entirely at 900px while
 * every display option stays inline. A cell that can always give is a cell that
 * pays for everyone.
 *
 * **The unit is the cell's own font size, not pixels.** The floor is about
 * LEGIBILITY — how many characters survive — and characters scale with the
 * active typography and density presets, which change at runtime. A px constant
 * would mean sixteen characters under one preset and ten under another: the same
 * mistake as the `MORE_BTN_W = 32` this primitive replaced, in a different
 * costume, and the same reason `readRowMetrics` reads the row's gap off the
 * rendered element rather than re-deriving it from the `gap` prop.
 *
 * `ch` — the width of the "0" glyph — is the more literal unit for "how many
 * characters", but reading one costs a measured glyph: an element to insert, a
 * reflow to read it, per pass. `em` is in the computed style already, scales
 * with the ambient font identically, and differs from `ch` by a constant factor
 * that this number is chosen in anyway.
 *
 * **8em** is ~112px at the pane header's 14px, and a proportional UI sans
 * averages about half an em per glyph — so roughly 16 characters, which is where
 * a truncated title still tells two panes apart ("Une Sorcière Com…",
 * "conversation-det…"). Below that it is a stub, and a stub is not worth the
 * room the actions gave up for it.
 *
 * One number in the primitive rather than a prop at every call site: what makes
 * a title legible is a property of text, not of the surface hosting it, and a
 * knob here would be a knob every consumer has to have an opinion about.
 */
const YIELD_FLOOR_EM = 8;

/**
 * What the CSS-wide initial `medium` font size resolves to, used only where the
 * computed style answers with a keyword instead of a length — which is jsdom,
 * whose `getComputedStyle` returns `"medium"` for an unset font size. A real
 * engine always answers in `px`.
 *
 * Not a silent absorb of a bad read: the alternative is a floor of 0, which is
 * this feature switched off, and a suite that cannot drive the floor is a suite
 * that pins nothing about it. A test that cares sets an inline `font-size`,
 * which jsdom resolves faithfully.
 */
const MEDIUM_FONT_PX = 16;

/**
 * The room this bar must hold back from its occupants for the yielding cell.
 *
 * Zero when there is no yielding child, and zero when it is rendering nothing.
 * Otherwise {@link YIELD_FLOOR_EM} times the cell's OWN computed font size —
 * the cell's, not the row's, because the title may set its own type scale and
 * the floor is about that text.
 */
export function yieldFloorPx(el: HTMLElement | null): number {
  if (el === null || rendersNothing(el)) return 0;
  const fontPx = Number.parseFloat(getComputedStyle(el).fontSize);
  return YIELD_FLOOR_EM * (Number.isFinite(fontPx) ? fontPx : MEDIUM_FONT_PX);
}

/**
 * Drops a growing yield cell's grow while its bar holds an explicit slack
 * claimant (`data-slack-claim`, a reorder spacer) OUTSIDE the cell, so the two
 * never split the row's slack. `flex-initial` (0 1 auto), not `grow-0`: the
 * grow cell's basis is 0, so dropping only the grow would collapse the title to
 * nothing — it has to go back to its own content width, still free to shrink
 * below it.
 *
 * A claimant INSIDE the cell (a spacer in the title's own slot, e.g. the
 * conversation header pushing its chips right) is the opposite case: that
 * spacer can only take slack the cell has, so the cell must keep growing —
 * hence the `:not(:has(…))`, or the whole title would bunch at the row's end.
 *
 * Spelled as `[bar]:has(claim) <this cell>`, never Tailwind's
 * `group-has-*`: that compiles to `:is(.group:has(…) *)`, whose `*` makes
 * Chrome restyle the whole subtree under every `:has()`-flagged ancestor on
 * each DOM insertion or removal (a zooming map swapped seconds of restyles).
 */
const YIELD_TO_SLACK_CLAIM =
  "[[data-adaptive-bar-root]:has([data-slack-claim])_&:not(:has([data-slack-claim]))]:flex-initial";

export interface AdaptiveBarYieldProps {
  /**
   * Also take the row's leftover, making this cell a `Fill` — it gives AND
   * grows.
   *
   * Which is what a LEADING yielding child needs in an `align="end"` row: with
   * no growing cell the row's free space collects in front of everything, so a
   * title would be packed against the actions on the far edge instead of
   * sitting at the row's start. Growing here puts the slack between the two,
   * where a header's slack belongs, and a cell holding no content still holds
   * the slack — so a title-less header keeps its actions in exactly the same
   * place as a titled one.
   *
   * Unless the row holds a reorder `spacer`: the author then placed the slack
   * themselves, so this cell stops growing and whatever follows it sits right
   * against it instead of halfway across the row.
   *
   * It stays invisible to the fit either way: `flex: 1 1 0%` contributes no
   * width of its own to the row, and `min-w-0` means the grow is surrendered
   * first when the occupants need the room. Default false — a yielding child
   * that merely sits among its neighbours (a trailing status strip) wants the
   * bar to hand out the slack, not this cell.
   */
  grow?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * The bar's one **yielding** child: the row's give.
 *
 * Everything else in a bar is an occupant — measured, laddered, demoted, and
 * relocated when the row runs out of room — and rigid, because the width ledger
 * rests on an occupant's width being its own. This is the opposite of all of
 * that, and it is the pane title's shape:
 *
 * - **Excluded from the fit ledger.** It never registers, and the bar's math
 *   reads registered containers' rects, so it is invisible to the fit by
 *   construction rather than by a flag the fit has to remember to skip. It is
 *   never measured, never demoted, never relocated.
 * - **{@link yieldClass} rather than rigid.** `min-w-0` lets it fall below its
 *   own content width, so it absorbs whatever the occupants leave and the
 *   `<Text>` inside it ellipsizes — instead of pushing the actions out of the
 *   row, which is what a rigid title does.
 * - **Down to a floor, and no further.** It reserves {@link YIELD_FLOOR_EM} of
 *   its own font size out of the fit's budget, so pressure past that width is
 *   the row overflowing and the bar relocates an occupant instead of taking the
 *   last of the title. Without it this cell gives first and gives everything,
 *   the row never overflows, and nothing else is ever asked to move.
 *
 * It takes no slack by default (`flex-grow` stays 0): a yielding child sits
 * against its neighbours, and the row's slack is the bar's to hand out. Pass
 * {@link AdaptiveBarYieldProps.grow} when this cell should hold that slack
 * itself, which is what a LEADING title in an `align="end"` row needs. The
 * other child that grows is the
 * reorder `spacer` node — the other half of `Fill`
 * ([`grow`](../../../css/plugins/grow/CLAUDE.md) to this one's
 * [`yield`](../../../css/plugins/yield/CLAUDE.md)) — which needs nothing from
 * this primitive: `flex: 1 1 0%` with no content contributes no width to the
 * row, so the fit's sum-of-occupants is untouched either way.
 *
 * **At most one per bar, enforced loudly.** See `BarRegistry.claimYield`: two
 * of them would split the leftover between themselves, both ellipsize, and
 * which one loses would be decided by their content rather than by the author.
 *
 * Outside a bar it is still an ordinary yielding cell — a primitive that only
 * works in one place is a primitive nobody composes, the same reason
 * `AdaptiveBar.Item` is transparent there.
 */
export function AdaptiveBarYield({
  grow = false,
  children,
  className,
}: AdaptiveBarYieldProps): ReactElement {
  const registry = useContext(BarRegistryContext);
  const cellRef = useRef<HTMLDivElement>(null);

  // In an effect rather than in render: render is re-entrant and (under
  // StrictMode) double-invoked, so a claim taken there would accuse a bar of
  // holding two yielding children when it holds one. The commit phase is where
  // "these two are mounted at the same time" is a fact — and where the cell has
  // a node, which the claim now hands over: the floor is read off this element,
  // so the bar has to know which one it is.
  useLayoutEffect(() => {
    const cell = cellRef.current;
    if (registry === null || cell === null) return;
    // Whether this cell renders anything decides whether it reserves anything,
    // and the child list is the one signal that survives in both directions —
    // the same reason an occupant watches its own container (`bar-item.tsx`).
    // A title arriving after its data loads must start reserving room, and one
    // that goes away must stop.
    const observer = new MutationObserver(() => {
      registry.yieldContentChanged();
    });
    observer.observe(cell, { childList: true });
    const release = registry.claimYield(cell);
    return () => {
      observer.disconnect();
      release();
    };
  }, [registry]);

  // Growing, this cell IS a `Fill` — so it says so with `fillClasses`, the one
  // sanctioned home for the `min-w-0 flex-1` pair, rather than re-deriving it
  // from the two halves here. The grow is only the DEFAULT home of the slack:
  // when the row holds an explicit claimant (a reorder spacer, marked
  // `data-slack-claim`), the author has said where the slack goes, and a second
  // claimant would split it — stranding whatever sits between this cell and the
  // spacer in the middle of the row.
  const cellClass = grow
    ? // eslint-disable-next-line layout/no-adhoc-layout -- a grow withdrawn only while a sibling spacer claims the slack; no primitive expresses conditional slack
      cn(fillClasses("x"), YIELD_TO_SLACK_CLAIM)
    : yieldClass("x");

  return (
    <div ref={cellRef} className={cn(cellClass, className)}>
      {children}
    </div>
  );
}
