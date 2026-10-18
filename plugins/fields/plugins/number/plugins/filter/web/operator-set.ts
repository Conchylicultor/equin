import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import { NumberValueInput, NumberRangeInput } from "./components/number-filter";
import { numberLower } from "./internal/number-lower";

// The type key (`match`) is written at the contribution, where the closure
// engine reads it.
export const numberOperatorSet: Omit<FilterOperatorSet, "match"> = {
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
