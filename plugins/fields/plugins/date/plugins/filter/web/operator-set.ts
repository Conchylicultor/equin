import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import {
  DateValueInput,
  DateRangeInput,
  RelativeRangeInput,
} from "./components/date-filter";
import { dateLower } from "./internal/date-lower";

// The type key (`match`) is written at the contribution, where the closure
// engine reads it.
export const dateOperatorSet: Omit<FilterOperatorSet, "match"> = {
  domain: "instant",
  defaultOperator: "is",
  operators: [
    {
      id: "is",
      label: "Is",
      group: "Comparison",
      hasValue: true,
      ValueInput: DateValueInput,
      lower: dateLower.is,
    },
    {
      id: "is-before",
      label: "Is before",
      group: "Comparison",
      hasValue: true,
      ValueInput: DateValueInput,
      lower: dateLower["is-before"],
    },
    {
      id: "is-after",
      label: "Is after",
      group: "Comparison",
      hasValue: true,
      ValueInput: DateValueInput,
      lower: dateLower["is-after"],
    },
    // NOT `hidden`, and do not make them so again. The inclusive pair is the
    // ONLY way to state an open-ended bound that includes the boundary day —
    // "today and everything after", the single most common date filter there is
    // (every "Upcoming" view is one). "Is after Today" starts TOMORROW, and
    // "Is between" demands a second bound the intent does not have, so neither
    // covers this: hiding them removed the capability rather than tidying it.
    {
      id: "is-on-or-before",
      label: "Is on or before",
      group: "Comparison",
      hasValue: true,
      ValueInput: DateValueInput,
      lower: dateLower["is-on-or-before"],
    },
    {
      id: "is-on-or-after",
      label: "Is on or after",
      group: "Comparison",
      hasValue: true,
      ValueInput: DateValueInput,
      lower: dateLower["is-on-or-after"],
    },
    {
      id: "is-between",
      label: "Is between",
      group: "Comparison",
      hasValue: true,
      ValueInput: DateRangeInput,
      lower: dateLower["is-between"],
    },
    {
      id: "is-within-past",
      label: "Is within the past",
      group: "Relative",
      hasValue: true,
      ValueInput: RelativeRangeInput,
      lower: dateLower["is-within-past"],
    },
    {
      id: "is-within-next",
      label: "Is within the next",
      group: "Relative",
      hasValue: true,
      ValueInput: RelativeRangeInput,
      lower: dateLower["is-within-next"],
    },
    {
      id: "is-empty",
      label: "Is empty",
      group: "Presence",
      hasValue: false,
      lower: dateLower["is-empty"],
    },
    {
      id: "is-not-empty",
      label: "Is not empty",
      group: "Presence",
      hasValue: false,
      lower: dateLower["is-not-empty"],
    },
  ],
};
