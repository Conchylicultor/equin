import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import { BoolValueInput } from "./components/bool-filter";
import { boolLower } from "./internal/bool-lower";

// A bool rule constrains rows even with no stored operand: an absent value reads
// as "Unchecked", a real constraint. So `lower` never answers `undefined` here —
// which keeps the chip's rule count in step with what actually filters.
// The type key (`match`) is written at the contribution, where the closure
// engine reads it.
export const boolOperatorSet: Omit<FilterOperatorSet, "match"> = {
  domain: "boolean",
  defaultOperator: "is",
  operators: [
    {
      id: "is",
      label: "Is",
      hasValue: true,
      ValueInput: BoolValueInput,
      lower: boolLower.is,
    },
    {
      id: "is-not",
      label: "Is not",
      hasValue: true,
      ValueInput: BoolValueInput,
      lower: boolLower["is-not"],
    },
  ],
};
