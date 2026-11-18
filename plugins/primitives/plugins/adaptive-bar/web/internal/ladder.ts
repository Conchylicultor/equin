import type {
  ActionForm,
  ShrinkLadder,
  YieldEagerness,
} from "@plugins/primitives/plugins/action-presentation/web";

/**
 * What a widget that never declared anything gets: one rung, normal eagerness.
 * The bar may leave it alone or relocate it as itself, and nothing else — a
 * strict superset of the behaviours that were safe before this primitive
 * existed, which is why a contributor who never heard of the seam is safe.
 */
export const DEFAULT_LADDER: Required<ShrinkLadder> = {
  shrinksTo: [],
  yields: "normal",
  cohort: null,
};

/**
 * Eagerness → the rank `assign` sorts on. **Higher yields sooner.**
 *
 * `"never"` is the LOWEST rank, not a hard pin: it means "the last thing this
 * bar touches". A hard pin would be unrepresentable-by-construction only if
 * every bar could always satisfy it, and a row narrower than one occupant
 * cannot. So the eager widgets give first and a `"never"` widget still yields
 * before the row breaks — which is what the focused tab wants.
 */
const YIELD_RANK: Record<YieldEagerness, number> = {
  never: 0,
  late: 1,
  normal: 2,
  early: 3,
};

export function yieldRankOf(ladder: Required<ShrinkLadder>): number {
  return YIELD_RANK[ladder.yields];
}

/**
 * The forms this widget can render **while still in the row**, widest first.
 *
 * `"row"` is deliberately not one of them. A rung names a form, never a place —
 * but `"row"` is the form a menu-safe widget renders *once it has left the
 * row*, so counting it as an inline rung would let the fit math "shrink" an
 * item to a width it never occupies inline.
 */
export function inlineRungsOf(ladder: Required<ShrinkLadder>): ActionForm[] {
  return ladder.shrinksTo.includes("compact") ? ["full", "compact"] : ["full"];
}

/**
 * The form to hand a widget for one placement.
 *
 * Evicted (`rung === null`) means "you are no longer in the row": a widget that
 * offered `"row"` renders as a labelled row in the panel, and everything else
 * renders as ITSELF — which is the entire point of relocation over
 * transformation.
 *
 * `useActionForm` filters this again on the widget's side. The duplication is
 * deliberate: the hook's filter is the structural guarantee (no region, present
 * or future, can transform a widget), and this one keeps the channel's value
 * honest so a debugger reading it is not looking at a lie the hook happens to
 * correct.
 */
export function formFor(
  ladder: Required<ShrinkLadder>,
  rung: number | null,
): ActionForm {
  if (rung === null) return ladder.shrinksTo.includes("row") ? "row" : "full";
  const rungs = inlineRungsOf(ladder);
  return rungs[Math.min(Math.max(rung, 0), rungs.length - 1)] ?? "full";
}
