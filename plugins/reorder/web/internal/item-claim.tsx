import { createContext } from "react";

/**
 * The per-item CLAIM: "the element directly below this provider was rendered as
 * an ITEM OF the enclosing reorder area, by that area's own `renderItem` call".
 *
 * It exists because `ReorderAreaContext` alone cannot express that. Context has
 * no depth limit and nothing below resets it, so *"inside a reorder area"* reads
 * as *"anywhere in the React subtree of one"* — while `applyItemMiddlewares` runs
 * on EVERY slot render path, `.Dispatch` and `renderIsolated` included. A slot
 * dispatched from inside a contribution therefore inherited the ancestor area and
 * registered `useSortable` with a per-CONTRIBUTION id, so N rendered instances of
 * one contribution meant N duplicate dnd-kit ids in a single `DndContext`.
 *
 * The claim is the CALL-PATH FLOOR the area context can't be: the list middleware
 * wraps each `renderItem(...)` result in a `value={true}` provider (which lands
 * directly above the item middleware's element), the item middleware consumes it,
 * and it re-provides `false` below — so nothing deeper can inherit membership at
 * any depth. The area context itself stays ambient on purpose: the item box
 * and the node types read it, and both are rendered BY the area.
 *
 * Deliberately a boolean, not an object/symbol: a stable primitive value that can
 * never churn its consumers on re-render.
 */
export const ReorderItemClaimContext = createContext<boolean>(false);
