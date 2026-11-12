/** The task category an Investigate on a failing test file files under. */
export const TESTS_CATEGORY_ID = "tests";

/** The subject an investigation of one test file is about (tasks/task-subject). */
export function testFileSubject(path: string): { kind: string; id: string } {
  return { kind: "test-file", id: path };
}
