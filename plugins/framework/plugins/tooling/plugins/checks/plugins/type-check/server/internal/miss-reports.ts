/**
 * A worker run whose affected set MISSED (program 2 found a name moved that it
 * had predicted stable) answered from one whole program, so its verdict is
 * right — but the miss is a bug in the prediction, and a run that only says
 * so in its transcript is a run nobody reads. Every miss is filed as a
 * `type-check-divergence` report (kind `prediction`), through the report
 * outbox: the worker's callers (a check, a build) are CLI processes with no
 * server to record it. The backstop's divergences go the same way.
 *
 * Filing never changes the verdict: a report the outbox refuses is a
 * transcript line, not a failed check — failing here would block every run on
 * a bug whose answer was already correct.
 */
import type {
  FileReportOutcome,
  ProcessReport,
} from "@plugins/reports/plugins/outbox/core";
import {
  TYPE_CHECK_DIVERGENCE_KIND,
  type TscPredictionMiss,
  type TypeCheckDivergencePayload,
} from "../../core";

/** Where the reports go: the real outbox, or a test's fake. */
export interface MissReportSink {
  file(report: ProcessReport): Promise<FileReportOutcome>;
  /** The commit the checkout is on. */
  head(): Promise<string>;
}

/** The same bug seen many times: one report per name is enough to act on. */
const MAX_REPORTS = 20;

/** File each miss; the transcript lines saying what was filed. */
export async function reportMisses(
  missed: readonly TscPredictionMiss[],
  sink: MissReportSink,
): Promise<string[]> {
  if (missed.length === 0) return [];
  const head = await sink.head();
  const unfiled: string[] = [];
  for (const m of missed.slice(0, MAX_REPORTS)) {
    const data: TypeCheckDivergencePayload = {
      kind: "prediction",
      file: m.file,
      name: m.name,
      head,
    };
    const filed = await sink.file({
      kind: TYPE_CHECK_DIVERGENCE_KIND,
      message: `the type check's affected set missed ${m.file}#${m.name}: predicted stable, it moved`,
      data,
    });
    if (filed.outcome !== "written") {
      unfiled.push(`${m.file}#${m.name}: ${filed.outcome}`);
    }
  }
  const filedCount = Math.min(missed.length, MAX_REPORTS) - unfiled.length;
  return [
    `type-check: filed ${filedCount} type-check-divergence report(s) for the missed name(s) at ${head}${
      unfiled.length > 0 ? `; NOT filed: ${unfiled.join("; ")}` : ""
    }`,
  ];
}
