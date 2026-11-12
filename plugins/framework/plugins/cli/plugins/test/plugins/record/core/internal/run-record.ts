import { z } from "zod";

/**
 * What one `./equin test` run leaves behind for the test-status page
 * (`debug/tests`): a harvest record, one JSON file per run in the host-global
 * `testRunRecordsDir` (`<opId>.json`), written by the run's LEADER once its
 * verdict is in. Every backend ingests the directory into its own tables.
 *
 * A verdict is keyed by (test path, digest): the digest is the file's import
 * closure plus its runner's inputs (`test/plugins/digest`), so a run on code
 * that later lands unchanged counts for main without any "is this main?"
 * logic.
 *
 * Only facts the run itself established are recorded: a file in a runner's
 * JUnit report is `passed` / `failed`; a file absent from the report of a
 * runner that exited non-zero is `not-loaded`; a runner that wedged or wrote
 * no report contributes NO file rows (its failure stays on the run).
 */
export const TEST_RUN_RECORD_VERSION = 1;

/** Who started the run (`EQUIN_TEST_ORIGIN`; unset = an agent typed it). */
export const TEST_RUN_ORIGINS = ["agent", "run-now", "idle"] as const;
export const TestRunOriginSchema = z.enum(TEST_RUN_ORIGINS);
export type TestRunOrigin = z.infer<typeof TestRunOriginSchema>;

export const TEST_FILE_OUTCOMES = ["passed", "failed", "not-loaded"] as const;
export const TestFileOutcomeSchema = z.enum(TEST_FILE_OUTCOMES);
export type TestFileOutcome = z.infer<typeof TestFileOutcomeSchema>;

const RunnerSchema = z.enum(["bun:test", "vitest"]);

/** A failing case's detail is cut to this many characters. */
export const TEST_FAILURE_DETAIL_MAX = 4096;

export const TestFileResultSchema = z.object({
  path: z.string(),
  runner: RunnerSchema,
  digest: z.string(),
  outcome: TestFileOutcomeSchema,
  cases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type TestFileResult = z.infer<typeof TestFileResultSchema>;

export const TestCaseFailureSchema = z.object({
  path: z.string(),
  /** `<suite> > … > <case>`, below the file. */
  caseId: z.string(),
  message: z.string(),
  detail: z.string().max(TEST_FAILURE_DETAIL_MAX),
});
export type TestCaseFailure = z.infer<typeof TestCaseFailureSchema>;

export const TestRunRecordSchema = z.object({
  v: z.literal(TEST_RUN_RECORD_VERSION),
  opId: z.string(),
  /** The checkout's root the run ran in. */
  repo: z.string(),
  /** The namespace (worktree slug) the run ran in. */
  slug: z.string(),
  origin: TestRunOriginSchema,
  head: z.string().nullable(),
  treeHash: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  digestVersion: z.string(),
  runners: z
    .array(
      z.object({
        runner: RunnerSchema,
        exitCode: z.number().int(),
        files: z.number().int().nonnegative(),
        /** No per-file rows were derived from this runner (wedged, or no report). */
        unattributed: z.boolean(),
      }),
    )
    .max(2),
  files: z.array(TestFileResultSchema),
  failures: z.array(TestCaseFailureSchema),
});
export type TestRunRecord = z.infer<typeof TestRunRecordSchema>;

/**
 * The file a test record is stored at, inside the records dir: `<opId>.json`.
 * Atomic writers stage beside it under a `.tmp.` name, which readers skip.
 */
export function testRunRecordFileName(opId: string): string {
  return `${opId}.json`;
}

/** The opId of a record file name, or null for anything else in the dir (a staged write). */
export function testRunRecordOpId(fileName: string): string | null {
  const m = /^([^.]+)\.json$/.exec(fileName);
  return m?.[1] ?? null;
}

/** Records older than this are pruned by the next writer. */
export const TEST_RUN_RECORD_RETENTION_DAYS = 14;

/**
 * The whole checkout's digests, as `./equin test-digest --out <file>` writes
 * them for the `tests.checkout-digests` job: one entry per test file, or
 * `unchanged` when the caller's `--unless-tree` already names the current tree.
 */
export const CheckoutDigestsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("digests"),
    treeHash: z.string(),
    head: z.string().nullable(),
    digestVersion: z.string(),
    computedAt: z.string(),
    elapsedMs: z.number(),
    files: z.array(
      z.object({
        path: z.string(),
        runner: RunnerSchema,
        digest: z.string(),
        pluginId: z.string().nullable(),
      }),
    ),
  }),
  z.object({ kind: z.literal("unchanged"), treeHash: z.string() }),
]);
export type CheckoutDigests = z.infer<typeof CheckoutDigestsSchema>;
