import type { FilterOperatorSet } from "@plugins/primitives/plugins/data-view/web";
import { boolOperatorSet as operators } from "../operator-set";

// The real bool operator set, as the Filter slot receives it (the contribution
// adds the `match` key), for another plugin's test to lower authored filters
// through exactly what the Filter control runs (e.g. mail's authored mailbox
// tabs).
export const boolOperatorSet: FilterOperatorSet = {
  match: "bool",
  ...operators,
};
