/**
 * Unit tests for the pure path-classification helpers of the
 * `table-defs-in-schema-glob` check: the candidate predicate that decides which
 * server files are in scope, and the imperative-table read-handle exemption.
 *
 * Neither input set is parsed out of anything any more. The glob set is the
 * `SCHEMA_GLOBS` constant, proved equal to drizzle.config.ts's evaluated
 * `schema:` array by the `database-migrations:drizzle-config-schema-globs` check;
 * the imperative name constants are `IMPERATIVE_PUBLIC_TABLE_CONSTS`, the keys of
 * the shorthand allowlist record, proved to name real barrel exports by the
 * `imperative-create-table-allowlisted` check. So both are supplied here as plain
 * literals — there is no extraction step left to unit-test.
 *
 * Run with `bun test` from the repo root.
 */

import { test, expect } from "bun:test";
import { isCandidatePath, strayPgTableCalls } from "./index";

// Sample paths use the real `improve` plugin so the `plugin-refs-resolve` check
// (which validates every `plugins/...` string literal repo-wide) stays happy —
// the predicate itself only cares about path structure + the supplied globFiles.
// A glob-matched schema file (would be in globFiles) is NOT a candidate.
const globFiles = new Set(["plugins/improve/server/internal/tables.ts"]);

test("a glob-matched tables.ts path is excluded (not a candidate)", () => {
  expect(isCandidatePath("plugins/improve/server/internal/tables.ts", globFiles)).toBe(false);
});

test("a non-glob server file is an in-scope candidate", () => {
  expect(isCandidatePath("plugins/improve/server/internal/helpers.ts", globFiles)).toBe(true);
});

test("a factory-body server file is a candidate (excluded later by FACTORY_DEFINITION_FILES, not the predicate)", () => {
  // The predicate only knows about globFiles; factory bodies are non-glob server
  // files, so they ARE candidates here and must be filtered separately.
  expect(
    isCandidatePath("plugins/infra/plugins/attachments/server/internal/define-link.ts", globFiles),
  ).toBe(true);
});

test("a .test.ts server file is out of scope", () => {
  expect(isCandidatePath("plugins/improve/server/internal/helpers.test.ts", globFiles)).toBe(false);
});

test("a __tests__ server file is out of scope", () => {
  expect(isCandidatePath("plugins/improve/server/__tests__/helpers.ts", globFiles)).toBe(false);
});

test("a non-server file is out of scope", () => {
  expect(isCandidatePath("plugins/improve/web/internal/tables.ts", globFiles)).toBe(false);
});

// --- imperative-table read-handle exemption ---

const names = new Set([
  "MIGRATIONS_TABLE_NAME",
  "DERIVED_VIEW_STATE_TABLE_NAME",
  "TASK_LATEST_CONVERSATION_TABLE",
]);

test("a pgTable read handle on an imperative name constant is exempt", () => {
  const src = [
    "export const _t = pgTable(TASK_LATEST_CONVERSATION_TABLE, {",
    '  id: text("id"),',
    "});",
  ].join("\n");
  expect(strayPgTableCalls(src, names)).toEqual([]);
});

test("a read handle the formatter wrapped (name on its own line) is exempt", () => {
  const src = [
    "export const _task_latest_conversation = pgTable(",
    "  TASK_LATEST_CONVERSATION_TABLE,",
    "  {",
    '    taskId: text("task_id").primaryKey(),',
    "  },",
    ");",
  ].join("\n");
  expect(strayPgTableCalls(src, names)).toEqual([]);
});

test("a comment before the name, or a generic call, does not defeat the exemption", () => {
  const src = [
    "const a = pgTable(/* rollup */ TASK_LATEST_CONVERSATION_TABLE, {});",
    "const b = pgTable<Cols>(",
    "  // the ledger",
    "  MIGRATIONS_TABLE_NAME,",
    "  {},",
    ");",
  ].join("\n");
  expect(strayPgTableCalls(src, names)).toEqual([]);
});

test("a pgTable on a non-imperative identifier is NOT exempt", () => {
  const src = [
    'import { pgTable } from "drizzle-orm/pg-core";',
    "export const x = pgTable(SOME_OTHER_TABLE, {});",
  ].join("\n");
  expect(strayPgTableCalls(src, names)).toEqual([
    { line: 2, text: "export const x = pgTable(SOME_OTHER_TABLE, {});" },
  ]);
});

test("a pgTable with a string-literal name is NOT exempt, wrapped or not", () => {
  const src = [
    'export const x = pgTable("agents", {});',
    "export const y = pgTable(",
    '  "tasks",',
    "  {},",
    ");",
  ].join("\n");
  expect(strayPgTableCalls(src, names).map((c) => c.line)).toEqual([1, 2]);
});

test("an imperative constant that is not the whole first argument is NOT exempt", () => {
  const src =
    "export const x = pgTable(prefix + TASK_LATEST_CONVERSATION_TABLE, {});";
  expect(strayPgTableCalls(src, names)).toHaveLength(1);
});

test("pgTable inside a comment or a string is not a call", () => {
  const src = ['// pgTable("x", {})', "const s = 'pgTable(\"y\", {})';"].join(
    "\n",
  );
  expect(strayPgTableCalls(src, names)).toEqual([]);
});
