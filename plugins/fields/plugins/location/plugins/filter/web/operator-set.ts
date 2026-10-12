import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";

/**
 * A location has no ordering or substring semantics, so the only operators are
 * presence tests, lowered over the `text` domain's emptiness (a missing location
 * projects to no value).
 */
export const locationOperatorSet: FilterOperatorSet = {
  match: "location",
  domain: "text",
  defaultOperator: "is-set",
  operators: [
    {
      id: "is-set",
      label: "Is set",
      hasValue: false,
      lower: (_operand, { column }) => clause(column, "isNotEmpty"),
    },
    {
      id: "is-not-set",
      label: "Is not set",
      hasValue: false,
      lower: (_operand, { column }) => clause(column, "isEmpty"),
    },
  ],
};
