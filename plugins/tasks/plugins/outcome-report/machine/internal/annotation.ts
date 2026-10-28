import { inArray } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { TreeDigest } from "@plugins/tasks/plugins/orchestration/plugins/tree-digest/server";
import { _taskOutcomeReportsExt } from "../../server/internal/tables";

const MAX = 120;

/** A report's first sentence, as one digest word: markdown emphasis and
 * headings dropped, cut at the first sentence end or line, capped. */
export function firstSentence(body: string): string {
  const line =
    body
      .split("\n")
      .map((l) =>
        l
          .replace(/^#+\s*/, "")
          .replace(/[*_`]/g, "")
          .trim(),
      )
      .find((l) => l !== "") ?? "";
  const end = line.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? line : line.slice(0, end + 1);
  return sentence.length > MAX ? `${sentence.slice(0, MAX - 1)}…` : sentence;
}

/** `report: <first sentence>` on every digested task that has a report. */
export const outcomeReportDigestAnnotation = TreeDigest.Annotation({
  id: "outcome-report",
  async annotate(tasks) {
    if (tasks.length === 0) return new Map();
    const rows = await db
      .select({
        taskId: _taskOutcomeReportsExt.taskId,
        body: _taskOutcomeReportsExt.body,
      })
      .from(_taskOutcomeReportsExt)
      .where(
        inArray(
          _taskOutcomeReportsExt.taskId,
          tasks.map((t) => t.id),
        ),
      );
    return new Map(
      rows.map((r) => [r.taskId, [`report: ${firstSentence(r.body)}`]]),
    );
  },
});
