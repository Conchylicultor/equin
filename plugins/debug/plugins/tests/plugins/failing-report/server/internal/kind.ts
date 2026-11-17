import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  TEST_FAILING_KIND,
  TestFailingPayloadSchema,
  testFailingFingerprint,
} from "../../core";
import { renderTestFailingTask } from "./render";

/**
 * The `test-failing` report kind: one row per test file of main that went
 * from passing to failing (confirmed by a second failing run), filed by main's
 * idle test runner. Category `error`, so the Error reports supervisor stream
 * carries it, with the fix ledger of every report.
 */
export const testFailingKind = ReportKind({
  kind: TEST_FAILING_KIND,
  schema: TestFailingPayloadSchema,
  fingerprint: testFailingFingerprint,
  meta: {
    tag: "[test-failing]",
    notif: "A test started failing on main",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) =>
    renderTestFailingTask(row, TestFailingPayloadSchema.parse(row.data)),
});
