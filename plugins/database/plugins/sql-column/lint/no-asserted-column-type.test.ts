/**
 * Tests for the `no-asserted-column-type` lint rule. Run with `bun test`.
 *
 * The invalid list is the three spellings that narrow a column's type without a
 * decoder: `$type` on a text-family root, an `{ enum: [...] }` config, and
 * `$type` on a `jsonb` root. The valid list is everything the rule must NOT
 * touch — and most of it is load-bearing scope, not politeness: a bare
 * `jsonb("x")` declares the `unknown` the column really holds, and
 * `defineEntity`'s generic `b.$type()` gets its type from a field's own schema
 * and needed a different fix entirely.
 *
 * That first paragraph used to be a claim about this file rather than a fact
 * about it: the jsonb tier had no invalid case at all, so dropping `jsonb` from
 * the rule's `COLUMN_FACTORIES` would have left every test green while the ~25
 * migrated `parsedJson` columns became free to re-assert. The message-coverage
 * test at the foot of the file is what makes the paragraph true by construction
 * — a message arm the rule declares but no invalid case reaches is now a
 * failure, so a fourth arm cannot ship untested either.
 */

import { expect, test } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-asserted-column-type";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

/** A file inside the owner directory, where the rule must stay silent. */
const OWNED =
  "plugins/database/plugins/sql-column/server/internal/parsed-text.ts";
/** An ordinary consumer file, where it must fire. */
const CONSUMER = "plugins/infra/plugins/jobs/server/internal/tables.ts";

/**
 * The cases, hoisted so the message-coverage test reads the SAME array the
 * harness runs — a coverage check against a second copy would only prove the
 * copy.
 * Typed off the harness's own parameter so the shape cannot be restated here.
 */
type Cases = Parameters<RuleTester["run"]>[2];

const cases: Cases = {
  valid: [
    // --- The sanctioned door: the type comes from the schema. ---
    {
      code: 'const c = parsedText("status", JobWaitStatusSchema).notNull();',
    },
    {
      code: 'const c = parsedText("auto_start_model", StoredModelSchema).notNull();',
    },

    // --- A plain text column claims nothing, so there is nothing to verify. ---
    { code: 'const c = text("name").notNull();' },
    { code: 'const c = text("error_message");' },
    { code: 'const c = varchar("slug", { length: 64 }).notNull();' },

    // --- The jsonb door, and the honest `unknown` that needs no door. ---
    { code: 'const c = parsedJson("manifest", BackupManifestSchema);' },
    { code: 'const c = jsonb("input");' },
    { code: 'const c = jsonb("meta").notNull().default({});' },

    // --- `defineEntity`'s generic call: no type argument, non-literal root. ---
    { code: "b = b.$type();" },
    { code: "let b = build(columnName); b = b.$type<T>();" },

    // --- `$type` on something that is not a column builder at all. ---
    { code: "const c = someOther.$type<Foo>();" },

    // --- The owner directory documents the banned forms in order to name them. ---
    { code: 'const c = text("x").$type<"a" | "b">();', filename: OWNED },
    { code: 'const c = text("x", { enum: ["a", "b"] });', filename: OWNED },
    { code: 'const c = jsonb("x").$type<Foo>();', filename: OWNED },
  ],
  invalid: [
    // --- The assertion, in every shape the five real sites take. ---
    {
      code: 'const c = text("level").$type<EffortLevel>().notNull();',
      filename: CONSUMER,
      errors: [{ messageId: "assertedColumnType" }],
    },
    {
      code: 'const c = text("status").$type<"pending" | "resolved">().notNull();',
      errors: [{ messageId: "assertedColumnType" }],
    },
    {
      code: 'const c = text("status").$type<ExecutionStatus>().notNull().default("pending");',
      errors: [{ messageId: "assertedColumnType" }],
    },
    // Behind an intervening builder call — the chain still roots in `text(`.
    {
      code: 'const c = text("status").notNull().$type<Status>();',
      errors: [{ messageId: "assertedColumnType" }],
    },
    // The other text-family builders are the same hole.
    {
      code: 'const c = varchar("kind", { length: 16 }).$type<Kind>();',
      errors: [{ messageId: "assertedColumnType" }],
    },
    {
      code: 'const c = char("code").$type<Code>();',
      errors: [{ messageId: "assertedColumnType" }],
    },
    // Computed member access is the same call.
    {
      code: 'const c = text("status")["$type"]<Status>();',
      errors: [{ messageId: "assertedColumnType" }],
    },

    // --- The runtime list: a better type, still an unverified value. ---
    {
      code: 'const c = text("source", { enum: ["heuristic", "push"] }).notNull();',
      errors: [{ messageId: "enumColumnConfig" }],
    },
    {
      code: 'const c = text("phase", { enum: PHASE_ORDER });',
      errors: [{ messageId: "enumColumnConfig" }],
    },
    {
      code: 'const c = varchar("kind", { length: 8, enum: ["a", "b"] });',
      errors: [{ messageId: "enumColumnConfig" }],
    },

    // --- Both spellings in one file are two separate reports. ---
    {
      code: 'const a = text("x").$type<A>();\nconst b = text("y", { enum: ["p", "q"] });',
      errors: [
        { messageId: "assertedColumnType" },
        { messageId: "enumColumnConfig" },
      ],
    },

    // --- The jsonb tier, in the shapes the ~25 migrated columns took. ---
    // A bare assertion, the `backup_runs.manifest` / `page_blocks.data` shape.
    {
      code: 'const c = jsonb("manifest").$type<BackupManifest>();',
      filename: CONSUMER,
      errors: [{ messageId: "assertedJsonColumnType" }],
    },
    // Behind intervening builder calls and a default — `reports.data`,
    // `workflow_execution_steps.config`. The chain still roots in `jsonb(`.
    {
      code: 'const c = jsonb("data").$type<Record<string, unknown>>().notNull().default({});',
      errors: [{ messageId: "assertedJsonColumnType" }],
    },
    // `$type` last, after the builder call — `notifications.metadata`.
    {
      code: 'const c = jsonb("metadata").notNull().$type<Metadata>();',
      errors: [{ messageId: "assertedJsonColumnType" }],
    },
    // Computed member access is the same call, one tier over.
    {
      code: 'const c = jsonb("presets")["$type"]<Presets>();',
      errors: [{ messageId: "assertedJsonColumnType" }],
    },

    // The two tiers carry DIFFERENT remedies — `parsedText` vs `parsedJson` —
    // so a file holding both must report one of each. Pins the tier ternary:
    // routing a jsonb column to the text message would tell its author to
    // reach for a decoder that cannot decode it.
    {
      code: 'const a = text("x").$type<A>();\nconst b = jsonb("y").$type<B>();',
      errors: [
        { messageId: "assertedColumnType" },
        { messageId: "assertedJsonColumnType" },
      ],
    },
  ],
};

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-asserted-column-type",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  cases,
);

test("every declared message is reached by an invalid case", () => {
  // `errors` is `number | (string | RegExp | TestCaseError)[]` (a RegExp entry
  // since eslint 10, matching the message text) — RuleTester also accepts
  // a bare COUNT, which asserts how many reports fired and not which. Such a
  // case contributes nothing here, deliberately: rewriting the only case for a
  // message into a count would leave that message unreached, and this test is
  // what says so.
  const reached = new Set(
    (cases.invalid ?? []).flatMap((c) => {
      const errors = typeof c === "string" ? [] : c.errors;
      if (!Array.isArray(errors)) return [];
      return errors.flatMap((e) =>
        typeof e === "object" &&
        e !== null &&
        !(e instanceof RegExp) &&
        typeof e.messageId === "string"
          ? [e.messageId]
          : [],
      );
    }),
  );
  // A message the rule declares but nothing here reaches is an arm of the rule
  // whose deletion no test would notice — which is how the jsonb tier came to
  // guard ~25 columns on inspection alone.
  expect([...Object.keys(rule.meta.messages)].sort()).toEqual(
    [...reached].sort(),
  );
});
