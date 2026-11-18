import slotUseSite from "./slot-use-site";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "semaphore",
  rules: {
    // Only the resource primitives hold a use-scoped slot (`usingSlot`).
    "slot-use-site": slotUseSite,
  },
  // A new holder is a reviewed, sanctioned exemption in its own plugin — never
  // debt to come back to.
  noDebt: ["slot-use-site"],
} satisfies LintContribution;
