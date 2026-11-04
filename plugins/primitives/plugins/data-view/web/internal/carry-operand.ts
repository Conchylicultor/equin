import type { FilterOperator } from "../../core";

/**
 * The operand a rule keeps when its operator changes from `from` to `to` —
 * so switching "Is Done" to "Is not" still reads "Done".
 *
 * - `to` takes no operand → none.
 * - Same operand editor (`ValueInput`) → the same shape: kept as is.
 * - Both declare an `arity` → one item ↔ a list of the same items
 *   (`x` → `[x]`; a list → its first item).
 * - Otherwise the shapes are unrelated → dropped.
 */
export function carryOperand(
  from: FilterOperator | undefined,
  to: FilterOperator | undefined,
  operand: unknown,
): unknown {
  if (!from || !to || !to.hasValue || operand === undefined) return undefined;
  if (from.ValueInput !== undefined && from.ValueInput === to.ValueInput) {
    return operand;
  }
  if (from.arity && to.arity) {
    if (from.arity === to.arity) return operand;
    if (to.arity === "many") return [operand];
    return Array.isArray(operand) ? operand[0] : undefined;
  }
  return undefined;
}
