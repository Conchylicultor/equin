/**
 * Tests for `collect-through-companion` and `collector-from-matches` — both
 * type-aware: each case is linted as a virtual `web/case.ts` below this
 * folder (so it lies in plugin `primitives.report-sink`, in a `web/` folder),
 * type-checked under an inferred project (`createTypedRuleTester`). The
 * cross-plugin sink is a real one, imported by relative path (the inferred project maps no
 * `@plugins` alias): error-boundary's `boundaryReportSink`.
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import collectThroughCompanion from "./collect-through-companion";
import collectorFromMatches from "./collector-from-matches";

// The first case pays for building the inferred project's program.
setDefaultTimeout(120_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "web/case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

const PRELUDE = `
import type { ReportSink } from "../../core";
import { boundaryReportSink } from "../../../error-boundary/web";
declare const ownSink: ReportSink<string>;
declare function drain(sink: unknown, handler: (b: never) => unknown): unknown;
declare const ReportSinks: { Collector(p: object): unknown };
declare const handler: (b: never) => unknown;
void boundaryReportSink;
`;

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = <M extends string>(code: string, messageId: M) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: [{ messageId }],
});

ruleTester.run("collect-through-companion", collectThroughCompanion, {
  valid: [
    // Its own plugin's sink: the collector carries nothing new.
    valid(`ownSink.register(null);`),
    valid(`boundaryReportSink.emit({} as never);`),
  ],
  // The flagged case — a real sink of another plugin — cannot be typed here:
  // its module's own `@plugins` imports do not resolve in the inferred
  // project, so its type reads as `any`. The repo-wide type-aware lint run
  // (the `type-check` check) is where the rule meets it.
  invalid: [],
});

ruleTester.run("collector-from-matches", collectorFromMatches, {
  valid: [
    valid(
      `ReportSinks.Collector({ from: "primitives.error-boundary", collect: drain(boundaryReportSink, handler), companion: true });`,
    ),
  ],
  invalid: [
    invalid(
      `ReportSinks.Collector({ from: "page.editor", collect: drain(boundaryReportSink, handler), companion: true });`,
      "mismatch" as const,
    ),
    invalid(
      `const c = drain(boundaryReportSink, handler); ReportSinks.Collector({ from: "primitives.error-boundary", collect: c, companion: true });`,
      "shape" as const,
    ),
  ],
});
