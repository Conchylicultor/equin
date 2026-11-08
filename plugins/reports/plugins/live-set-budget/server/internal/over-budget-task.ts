import type { ReportRow } from "@plugins/reports/server";
import { LiveSetOverBudgetPayloadSchema } from "../../core";

// A set past its budget stays past it on every load until fixed, so re-alert
// at most every 6h for one known problem (as resource-error).
export const LIVE_SET_OVER_BUDGET_NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function renderOverBudgetTask(row: ReportRow): {
  title: string;
  description: string;
} {
  // Validated at ingest, so a failure here is a corrupted row (loud).
  const d = LiveSetOverBudgetPayloadSchema.parse(row.data);
  const scope = Object.entries(d.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return {
    title: `[live-set] ${d.key} holds ${d.rows} rows, past its budget of ${d.budget}`,
    description: [
      `The live collection \`${d.key}\` is declared \`all: { unbounded: { reason, budget: ${d.budget} } }\` — held whole, every row sent to every reader — and a load${scope === "" ? "" : ` of the tuple \`{ ${scope} }\``} read **${d.rows} rows**.`,
      "",
      "Its declared reason:",
      "",
      `> ${d.reason}`,
      "",
      "That claim is no longer true (or the budget was set too low).",
      "",
      "**Fix**, in order of preference:",
      "- the set grew without limit → read it as a bounded window (`default` + `maxLimit`) or by id, or scope it (`all: { by }`);",
      "- it is bounded but larger than measured → cap it (`all: { max }`, refused past it), or re-measure on main and raise `budget` with a reason saying what bounds it.",
      "",
      `**Occurrences:** ${row.count}`,
      `**Worktree:** ${row.worktree}`,
      `**First seen:** ${row.firstSeenAt.toISOString()}`,
      `**Last seen:** ${row.lastSeenAt.toISOString()}`,
    ].join("\n"),
  };
}
