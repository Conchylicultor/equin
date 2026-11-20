/**
 * Tests for `sink-id-matches-declaration` — a type-aware rule: each case is
 * linted as a virtual file under this plugin (`primitives/plugins/report-sink`),
 * so a sink bound to `const fooSink` must carry the id
 * `primitives/plugins/report-sink:fooSink`.
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./sink-id-matches-declaration";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;
const ID = (binding: string) => `"primitives/plugins/report-sink:${binding}"`;

const PRELUDE = `
declare function defineReportSink<T>(id: string): { id: string; emit(b: T): void };
declare function defineRequestSink<T, R>(id: string): { id: string; emit(b: T): R | undefined };
declare const someId: string;
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

ruleTester.run("sink-id-matches-declaration", rule, {
  valid: [
    valid(`export const fooSink = defineReportSink<string>(${ID("fooSink")});`),
    valid(
      `const barSink = defineRequestSink<string, boolean>(${ID("barSink")});`,
    ),
  ],
  invalid: [
    {
      filename: FILENAME,
      code:
        PRELUDE +
        `export const fooSink = defineReportSink<string>("x:fooSink");`,
      output:
        PRELUDE +
        `export const fooSink = defineReportSink<string>(${ID("fooSink")});`,
      errors: [{ messageId: "mismatch" as const }],
    },
    {
      filename: FILENAME,
      code:
        PRELUDE +
        `export const fooSink = defineReportSink<string>(${ID("barSink")});`,
      output:
        PRELUDE +
        `export const fooSink = defineReportSink<string>(${ID("fooSink")});`,
      errors: [{ messageId: "mismatch" as const }],
    },
    {
      filename: FILENAME,
      code:
        PRELUDE + `export const fooSink = defineReportSink<string>(someId);`,
      output:
        PRELUDE +
        `export const fooSink = defineReportSink<string>(${ID("fooSink")});`,
      errors: [{ messageId: "notLiteral" as const }],
    },
    {
      filename: FILENAME,
      code:
        PRELUDE + `let fooSink = defineReportSink<string>(${ID("fooSink")});`,
      errors: [{ messageId: "notBound" as const }],
    },
    {
      filename: FILENAME,
      code:
        PRELUDE + `const sinks = [defineReportSink<string>(${ID("fooSink")})];`,
      errors: [{ messageId: "notBound" as const }],
    },
  ],
});
