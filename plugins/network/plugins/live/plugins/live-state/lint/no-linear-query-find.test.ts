/**
 * Tests for `no-linear-query-find` — a type-aware rule: each case is linted as
 * a virtual `case.ts` beside this file, type-checked under an inferred project
 * (`createTypedRuleTester`).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-linear-query-find";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

const PRELUDE = `
declare class QueryCache { find(f: unknown): unknown; findAll(f: unknown): unknown[]; get(hash: string): unknown }
declare class QueryClient { getQueryCache(): QueryCache }
declare const client: QueryClient;
declare const cache: QueryCache;
declare const maybeCache: QueryCache | undefined;
declare const rows: number[];
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: [{ messageId: "linearFind" as const }],
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

ruleTester.run("no-linear-query-find", rule, {
  valid: [
    valid(`cache.get("h");`),
    valid(`cache.findAll({ queryKey: ["k"] });`),
    valid(`rows.find((r) => r > 1);`),
  ],
  invalid: [
    invalid(`client.getQueryCache().find({ queryKey: ["k"], exact: true });`),
    invalid(`cache.find({ queryKey: ["k"] });`),
    invalid(`maybeCache?.find({ queryKey: ["k"] });`),
  ],
});
