import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import { EnumSingleInput, EnumMultiInput } from "./components/enum-filter";
import { enumLower } from "./internal/enum-lower";

// The type key (`match`) is written at the contribution, where the closure
// engine reads it.
export const enumOperatorSet: Omit<FilterOperatorSet, "match"> = {
  domain: "text",
  defaultOperator: "is",
  operators: [
    {
      id: "is",
      label: "Is",
      hasValue: true,
      ValueInput: EnumSingleInput,
      lower: enumLower.is,
    },
    {
      id: "is-not",
      label: "Is not",
      hasValue: true,
      ValueInput: EnumSingleInput,
      lower: enumLower["is-not"],
    },
    {
      id: "is-any-of",
      label: "Is any of",
      hasValue: true,
      ValueInput: EnumMultiInput,
      lower: enumLower["is-any-of"],
    },
    {
      id: "is-none-of",
      label: "Is none of",
      hasValue: true,
      ValueInput: EnumMultiInput,
      lower: enumLower["is-none-of"],
    },
    {
      id: "is-empty",
      label: "Is empty",
      hasValue: false,
      lower: enumLower["is-empty"],
    },
    {
      id: "is-not-empty",
      label: "Is not empty",
      hasValue: false,
      lower: enumLower["is-not-empty"],
    },
  ],
};
