import { report } from "@plugins/reports/web";
import { clientSlowOpSink } from "@plugins/debug/plugins/slow-ops/plugins/sink/core";
import {
  dominantLayer,
  interactionTargetLabel,
  slowInteractionSummary,
  type SlowInteractionPayload,
} from "../../core";
import { INTERACTION, type InteractionVerdict } from "./interaction-judge";

// The slow-op every slow interaction lands as: one row per target (what was
// interacted with), the script that forced its style/layout — else its top
// function — as the variant, its breakdown as waits, the route as caller, its
// interval at its true end instant. Its alert is the `slow-interaction` report
// (reportedBy), filed only when severe or recurring.
const OPERATION_KIND = "interaction";
const REPORT_KIND = "slow-interaction";

function variantOf(d: SlowInteractionPayload): string {
  if (d.forcedBy && dominantLayer(d.breakdown).layer === "forced style/layout")
    return `forced by ${d.forcedBy}`;
  return d.topFunction ?? "unattributed";
}

/** Record one slow interaction, and report it when the verdict says so. */
export async function fileSlowInteraction(
  d: SlowInteractionPayload,
  verdict: InteractionVerdict,
): Promise<void> {
  clientSlowOpSink.emit({
    operationKind: OPERATION_KIND,
    operation: interactionTargetLabel(d.target),
    durationMs: d.durationMs,
    thresholdMs: INTERACTION.RECORD_MIN_MS,
    caller: { kind: "route", label: new URL(d.url).pathname },
    // A partition of the duration (the input delay is a phase, not a layer:
    // it is time some script held the thread, already counted below).
    waits: {
      script: d.breakdown.scriptMs,
      "forced-style-layout": d.breakdown.forcedStyleLayoutMs,
      "style-layout": d.breakdown.styleLayoutMs,
      "render-other": d.breakdown.otherMs,
    },
    detail: { variant: variantOf(d) },
    endedAt: d.startedAt + d.durationMs,
    reportedBy: REPORT_KIND,
  });
  if (verdict !== "report") return;
  await report({
    kind: REPORT_KIND,
    source: "client-slow-interaction",
    data: d,
    message: slowInteractionSummary(d),
    url: d.url,
  });
}
