import { z } from "zod";
import { nullable, type FieldsRecord } from "@plugins/fields/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { durationField } from "@plugins/fields/plugins/duration/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { externalIdField } from "@plugins/ids/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { TEST_STATUSES } from "./status";

// The vocabularies the harvest records (`framework/cli/test/record`), restated
// as the closed lists this plugin's columns hold. Kept as data here rather than
// imported: that plugin's core is host tooling the page's browser bundle must
// not load (`boundaries:web-loads-portable`), and the ingest parses every
// record against its schema, so a value outside these lists fails there.
export const TEST_RUNNERS = ["bun:test", "vitest"] as const;
export type TestRunner = (typeof TEST_RUNNERS)[number];
export const TEST_OUTCOMES = ["passed", "failed", "not-loaded"] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];
export const TEST_ORIGINS = ["agent", "run-now", "idle"] as const;
export type TestOrigin = (typeof TEST_ORIGINS)[number];

const runnerField = () =>
  enumTextField(TEST_RUNNERS, {
    label: "Runner",
    options: {
      "bun:test": { label: "bun" },
      vitest: { label: "jsdom" },
    },
  });

const outcomeOptions = {
  passed: { label: "Passed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  "not-loaded": { label: "Did not load", variant: "destructive" },
} as const;

const originOptions = {
  agent: { label: "Agent run" },
  "run-now": { label: "Run now" },
  idle: { label: "Idle run" },
} as const;

/** One harvested `./equin test` run (its record, minus the per-file rows). */
export const testRunFields = {
  opId: textField(),
  slug: textField(),
  origin: enumTextField(TEST_ORIGINS),
  repo: textField(),
  headSha: nullable(textField()),
  treeHash: textField(),
  startedAt: dateField(),
  finishedAt: dateField(),
  digestVersion: textField(),
  runners: jsonField({
    schema: cappedList(
      z.object({
        runner: z.enum(TEST_RUNNERS),
        exitCode: z.number().int(),
        files: z.number().int(),
        unattributed: z.boolean(),
      }),
      { max: TEST_RUNNERS.length },
    ),
    default: [],
  }),
  fileCount: intField(),
  failedCount: intField(),
} satisfies FieldsRecord;
export const testRunsEntityRef = entityRef("test_runs", testRunFields);

/**
 * One file's result in one run — the verdict, keyed by the digest it ran
 * under. `id` is `<opId>:<path>`: a run tests a file once.
 */
export const testFileResultFields = {
  id: externalIdField({
    reason:
      "derived, not minted: `<opId>:<path>`, the result's natural key (a run tests a file once)",
  }),
  opId: textField(),
  path: textField({ label: "File" }),
  runner: runnerField(),
  digest: textField(),
  outcome: enumTextField(TEST_OUTCOMES, {
    label: "Outcome",
    options: outcomeOptions,
  }),
  cases: intField({ label: "Cases" }),
  failedCases: intField({ label: "Failed" }),
  durationMs: durationField({ label: "Duration" }),
  finishedAt: dateField({ label: "Ran" }),
  origin: enumTextField(TEST_ORIGINS, {
    label: "Run by",
    options: originOptions,
  }),
  slug: textField({ label: "Checkout" }),
} satisfies FieldsRecord;
export const testFileResultsEntityRef = entityRef(
  "test_file_results",
  testFileResultFields,
);

/** One failing case of one file in one run, with what its runner said. */
export const testCaseFailureFields = {
  id: externalIdField({
    reason:
      "derived, not minted: the sha-256 of (opId, path, caseId), the failure's natural key",
  }),
  opId: textField(),
  path: textField(),
  caseId: textField(),
  message: textField(),
  detail: textField(),
} satisfies FieldsRecord;
export const testCaseFailuresEntityRef = entityRef(
  "test_case_failures",
  testCaseFailureFields,
);

/** Each test file of this checkout, with its digest NOW (`./equin test-digest`). */
export const testCheckoutDigestFields = {
  path: textField(),
  digest: textField(),
  runner: enumTextField(TEST_RUNNERS),
  pluginId: nullable(textField()),
  generation: textField(),
} satisfies FieldsRecord;
export const testCheckoutDigestsEntityRef = entityRef(
  "test_checkout_digests",
  testCheckoutDigestFields,
);

export const DIGEST_GENERATION_STATES = [
  "computing",
  "ready",
  "failed",
] as const;
export type DigestGenerationState = (typeof DIGEST_GENERATION_STATES)[number];

/** The one row naming which tree the checkout digests describe. */
export const TEST_DIGEST_GENERATION_ID = "checkout";
export const testDigestGenerationFields = {
  id: externalIdField({
    reason:
      "a singleton table: its one row's fixed id (TEST_DIGEST_GENERATION_ID)",
  }),
  state: enumTextField(DIGEST_GENERATION_STATES),
  /** The tree hash the stored digests describe; null before the first. */
  generation: nullable(textField()),
  headSha: nullable(textField()),
  computedAt: nullable(dateField()),
  /** When the running computation started; null when none runs. */
  computingSince: nullable(dateField()),
  fileCount: intField(),
  elapsedMs: nullable(intField()),
  error: nullable(textField()),
} satisfies FieldsRecord;
export const testDigestGenerationEntityRef = entityRef(
  "test_digest_generation",
  testDigestGenerationFields,
);

/** How many past results a status row carries for its history strip. */
export const STATUS_HISTORY_MAX = 16;

export const StatusHistoryEntrySchema = z.object({
  outcome: z.enum(TEST_OUTCOMES),
  /** Ran the file's current digest. */
  current: z.boolean(),
  origin: z.enum(TEST_ORIGINS),
  at: z.string(),
  opId: z.string(),
});
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntrySchema>;

/**
 * Each checkout test file's status (`deriveStatus`) and the last result it
 * had — derived, written only by `recomputeFileStatus`.
 */
export const testFileStatusFields = {
  path: textField({ label: "File" }),
  pluginId: nullable(textField({ label: "Plugin" })),
  runner: runnerField(),
  digest: textField(),
  status: enumTextField(TEST_STATUSES, {
    label: "Status",
    ordered: true,
    options: {
      failing: { label: "Failing", variant: "destructive" },
      flaky: { label: "Flaky", variant: "warning" },
      stale: { label: "Stale", variant: "muted" },
      passing: { label: "Passing", variant: "success" },
      never: { label: "Never run", variant: "muted" },
    },
  }),
  lastOutcome: nullable(
    enumTextField(TEST_OUTCOMES, { options: outcomeOptions }),
  ),
  lastRanAt: nullable(dateField({ label: "Ran" })),
  lastOpId: nullable(textField()),
  lastOrigin: nullable(enumTextField(TEST_ORIGINS, { options: originOptions })),
  lastSlug: nullable(textField()),
  cases: nullable(intField({ label: "Cases" })),
  failedCases: nullable(intField({ label: "Failed" })),
  durationMs: nullable(durationField({ label: "Duration" })),
  /** Results on the current digest that passed / did not. */
  currentPassed: intField(),
  currentFailed: intField(),
  history: jsonField({
    schema: cappedList(StatusHistoryEntrySchema, { max: STATUS_HISTORY_MAX }),
    default: [],
  }),
} satisfies FieldsRecord;
export const testFileStatusEntityRef = entityRef(
  "test_file_status",
  testFileStatusFields,
);
