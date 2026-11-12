import { Investigate } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import {
  TESTS_CATEGORY_ID,
  testFileRuns,
  testFileStatus,
  testFileSubject,
  type TestFileRunRow,
  type TestFileStatusRow,
} from "../../core";

/** What an agent investigating one test file is told. */
export function testFileBrief(
  file: Pick<
    TestFileStatusRow,
    "path" | "status" | "currentPassed" | "currentFailed"
  >,
  userText: string,
): string {
  const parts = [
    `The test file ${file.path} is ${file.status} on the current code (Debug → Tests).`,
    `Run it with \`./equin test ${file.path}\`, find the cause and fix it.`,
  ];
  if (file.status === "flaky")
    parts.push(
      `On the current code it passed ${file.currentPassed}× and failed ${file.currentFailed}× — find what makes it nondeterministic.`,
    );
  if (userText.trim()) parts.push(`Additional context: ${userText.trim()}`);
  return parts.join("\n\n");
}

const DESCRIPTION =
  "Launch an agent to find out why this test file fails and fix it.";

// A failing or flaky file, wherever the status collection is listed.
export const investigateFailingFiles = Investigate.Register<TestFileStatusRow>({
  owner: testFileStatus,
  failed: (f) => f.status === "failing" || f.status === "flaky",
  noun: "test",
  categoryId: TESTS_CATEGORY_ID,
  subject: (f) => testFileSubject(f.path),
  description: () => DESCRIPTION,
  brief: (f, userText) => testFileBrief(f, userText),
});

// A failed run of a file: the investigation is the file's (one task per file).
export const investigateFailedRuns = Investigate.Register<TestFileRunRow>({
  owner: testFileRuns,
  failed: (r) => r.outcome !== "passed",
  noun: "test",
  categoryId: TESTS_CATEGORY_ID,
  subject: (r) => testFileSubject(r.path),
  description: () => DESCRIPTION,
  brief: (r, userText) =>
    [
      `The test file ${r.path} ${r.outcome === "not-loaded" ? "did not load" : `failed ${r.failedCases} of ${r.cases} cases`} in run ${r.opId} (by ${r.origin} in ${r.slug}; Debug → Tests).`,
      `Run it with \`./equin test ${r.path}\`, find the cause and fix it.`,
      ...(userText.trim() ? [`Additional context: ${userText.trim()}`] : []),
    ].join("\n\n"),
});
