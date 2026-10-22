import { serveValue } from "@plugins/network/plugins/live/server";
import { _reports, ReportKind } from "@plugins/reports/server";
import { uninvestigatedReportCounts } from "@plugins/reports/plugins/engine/server";
import { reportInvestigationsScope } from "../../shared/live";

// The loader reads `reports` (the task link and noise flag that mark one
// investigated are columns of it), so a report write recomputes every held
// question (the declared `reads`). Reports land
// in bursts (one failure recorded by many tabs), hence the throttle. The kind
// list itself is the `ReportKind` contribution registry, fixed per process.
export const reportInvestigationsScopeServed = serveValue(
  reportInvestigationsScope,
  {
    source: "db",
    reads: {
      tables: [_reports],
      reason:
        "the open count per kind is over every uninvestigated report, so a write to any report may change any tuple; whole-table until it reads through a collection",
    },
    throttleMs: 1000,
    loader: async ({ minCount }) => {
      const counts = new Map(
        (await uninvestigatedReportCounts(minCount)).map((c) => [
          c.kind,
          c.reports,
        ]),
      );
      return {
        kinds: ReportKind.getContributions()
          .map((k) => ({
            kind: k.kind,
            variant: k.meta.variant,
            open: counts.get(k.kind) ?? 0,
          }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
      };
    },
  },
);
