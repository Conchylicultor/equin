/**
 * Tests for `no-direct-sink-register` — a type-aware rule: each case is linted
 * as a virtual `case.ts` beside this file (outside any `web/` folder),
 * type-checked under an inferred project (`createTypedRuleTester`).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-direct-sink-register";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

const PRELUDE = `
interface ReportSink<T> { register(fn: ((body: T) => void) | null): void; emit(body: T): void }
interface RequestSink<T, R> { register(fn: ((body: T) => R) | null): void; emit(body: T): R | undefined }
interface Job { register(): void }
declare const reportSink: ReportSink<string>;
declare const requestSink: RequestSink<string, boolean>;
declare const maybeSink: ReportSink<string> | undefined;
declare const job: Job;
declare function sinkHandler<H>(sink: { register(fn: H | null): void }, make: () => H): unknown;
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: [{ messageId: "direct" as const }],
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

ruleTester.run("no-direct-sink-register", rule, {
  valid: [
    valid(`sinkHandler(reportSink, () => (s: string) => void s);`),
    valid(`job.register();`),
    valid(`reportSink.emit("x");`),
  ],
  invalid: [
    invalid(`reportSink.register((s) => void s);`),
    invalid(`reportSink.register(null);`),
    invalid(`requestSink.register(() => true);`),
    invalid(`maybeSink?.register(null);`),
  ],
});
