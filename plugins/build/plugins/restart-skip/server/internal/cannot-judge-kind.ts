import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  CANNOT_JUDGE_REPORT_KIND,
  CannotJudgePayloadSchema,
  type CannotJudgePayload,
} from "../../core";

// The `restart-skip-cannot-judge` kind, filed by `./equin build` through the
// report outbox when the process it asked to adopt the deploy answered
// `cannot-judge`. One row per process kind: central, and every namespace's
// backend together (it is the same judgement over the same code, so one
// cause blinds them all; the row's latest data names the namespace).
export const cannotJudgeKind = ReportKind({
  kind: CANNOT_JUDGE_REPORT_KIND,
  schema: CannotJudgePayloadSchema,
  fingerprint: (d: CannotJudgePayload) =>
    `${CANNOT_JUDGE_REPORT_KIND}:${d.process}`,
  meta: {
    tag: "[restart-skip]",
    notif: "Restart-skip cannot judge a deploy",
    variant: "warning",
    category: "error",
  },
  renderTask: (row: ReportRow) => {
    const d = CannotJudgePayloadSchema.parse(row.data);
    const who =
      d.namespace === null ? "Central" : `The \`${d.namespace}\` backend`;
    return {
      title: `[restart-skip] ${d.namespace === null ? "central" : "backends"} cannot judge a deploy — restart-skip is off`,
      description: [
        `${who} was asked by a deploy whether a process started now would run ` +
          `exactly its code (\`build/restart-skip\`), and could not tell:`,
        "",
        `> ${d.reason}`,
        "",
        "The deploy restarted it, which is always safe — but the same refusal " +
          "repeats on every deploy, so restart-skip is off until the cause is " +
          "fixed, and every restart sends each open tab back through read " +
          "admission (the post-restart herd of slow `wait read-admit` ops).",
        "",
        "**What to do:** the reason names the import or load the closure walk " +
          "(`packages/source-digest`) refused. Make the walk able to measure " +
          "it (`shared/resolve.ts` mirrors Bun's resolution), or keep the code " +
          "out of what the server loads — never make the walk skip it.",
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});
