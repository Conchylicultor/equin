import { serveValue } from "@plugins/network/plugins/live/server";
import {
  ReportKind,
  uninvestigatedReportCounts,
} from "@plugins/reports/server";
import { reportInvestigationsScope } from "../../shared/live";

// The loader reads `reports` (and whatever marks one investigated), so the
// change feed recomputes every held question on a report write. Reports land
// in bursts (one failure recorded by many tabs), hence the throttle. The kind
// list itself is the `ReportKind` contribution registry, fixed per process.
export const reportInvestigationsScopeServed = serveValue(
  reportInvestigationsScope,
  {
    source: "db",
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
