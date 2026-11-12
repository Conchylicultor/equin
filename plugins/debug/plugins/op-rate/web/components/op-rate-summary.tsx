import type { Report } from "@plugins/reports/core";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { OpRatePayloadSchema } from "../../core";

// One-line call-rate summary for the Debug → Reports list, e.g.
// "`sub reports.list:rows` ×1912 — usually ≤249 (steady window)", or, judged on
// the warm-up bar, "… ×6204 — warm-up threshold 5000". The op (`kind:label`)
// renders as a mono chip; the per-window call count and its bar trail.
export function OpRateSummary({ report }: { report: Report }) {
  const parsed = OpRatePayloadSchema.safeParse(report.data);
  if (!parsed.success) return <>{report.message}</>;
  const d = parsed.data;

  return (
    <Inline gap="xs">
      <Badge variant="warning" mono>
        {d.kind}:{d.label}
      </Badge>
      <span>×{d.callsInWindow}</span>
      {d.baseline ? (
        <span>
          — usually ≤{d.baseline.usualCalls}{" "}
          {d.baseline.over === "hour"
            ? "per hour (this hour so far)"
            : `(${d.baseline.over} window)`}
        </span>
      ) : (
        <span>— warm-up threshold {d.threshold}</span>
      )}
    </Inline>
  );
}
