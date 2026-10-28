import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import {
  numberOperandInputs,
  type NumberOperandUnits,
} from "./components/number-filter";
import { numberLower } from "./internal/number-lower";

/**
 * Number's operator set — over plain numeric operands, or, handed a derived
 * type's `units`, over operands typed in those units (`30s`, `1 GB`). The
 * operands are the same stored number either way, so the lowering is
 * number's own: a derived type overrides only how its operand is typed.
 *
 * The type key (`match`) is written at the contribution, where the closure
 * engine reads it.
 */
export function numberOperatorSetWith(
  units?: NumberOperandUnits,
): Omit<FilterOperatorSet, "match"> {
  const { ValueInput: NumberValueInput, RangeInput: NumberRangeInput } =
    numberOperandInputs(units);
  return {
  domain: "number",
  defaultOperator: "=",
  operators: [
    {
      id: "=",
      label: "=",
      hasValue: true,
      ValueInput: NumberValueInput,
      lower: numberLower["="],
    },
    {
      id: "≠",
      label: "≠",
      hasValue: true,
      ValueInput: NumberValueInput,
      lower: numberLower["≠"],
    },
    {
      id: ">",
      label: ">",
      hasValue: true,
      ValueInput: NumberValueInput,
      lower: numberLower[">"],
    },
    {
      id: "<",
      label: "<",
      hasValue: true,
      ValueInput: NumberValueInput,
      lower: numberLower["<"],
    },
    {
      id: "≥",
      label: "≥",
      hasValue: true,
      ValueInput: NumberValueInput,
      lower: numberLower["≥"],
    },
    {
      id: "≤",
      label: "≤",
      hasValue: true,
      ValueInput: NumberValueInput,
      lower: numberLower["≤"],
    },
    {
      id: "between",
      label: "Between",
      hasValue: true,
      ValueInput: NumberRangeInput,
      lower: numberLower.between,
    },
    {
      id: "is-empty",
      label: "Is empty",
      hasValue: false,
      lower: numberLower["is-empty"],
    },
    {
      id: "is-not-empty",
      label: "Is not empty",
      hasValue: false,
      lower: numberLower["is-not-empty"],
    },
  ],
};
}

export const numberOperatorSet = numberOperatorSetWith();
