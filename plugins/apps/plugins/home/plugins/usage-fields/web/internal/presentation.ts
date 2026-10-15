import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { formatValue } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/core";
import { appUsageFields } from "../../core";

/** 42s, 12m, 3.5h — the chart kit's seconds formatter; 0 reads "—". */
function duration(ms: number | null): string | null {
  if (ms === null) return null;
  return ms === 0 ? "—" : formatValue("seconds", ms / 1000);
}

function count(n: number | null): string | null {
  return n === null ? null : String(n);
}

export const usagePresentation = FieldPresentation.Register({
  owner: appUsageFields,
  fields: {
    focusedMs7d: { align: "end", cell: duration },
    launches7d: { align: "end", cell: count },
    focusedMsTotal: { align: "end", cell: duration },
    launchesTotal: { align: "end", cell: count },
  },
});
