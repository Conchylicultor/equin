/**
 * Tests for `no-scrolling-focus` — a type-aware rule: each case is linted as a
 * virtual `case.ts` beside this file, type-checked under an inferred project
 * (`createTypedRuleTester` in `tooling/lint/core/testing`).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-scrolling-focus";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

const PRELUDE = `
declare const el: HTMLElement;
declare const input: HTMLInputElement | null;
declare const svg: SVGElement;
declare const ref: { current: HTMLDivElement | null };
declare const editor: { focus(cb?: () => void): void };
declare const handle: { focus(opts?: { scroll?: boolean }): void };
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: [{ messageId: "scrollingFocus" as const }],
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

ruleTester.run("no-scrolling-focus", rule, {
  valid: [
    // Not the DOM method: a Lexical-style editor, a caret surface's handle.
    valid(`editor.focus();`),
    valid(`handle.focus({ scroll: true });`),
    // A property merely named focus.
    valid(`const o = { focus: 1 }; o.focus;`),
  ],
  invalid: [
    invalid(`el.focus();`),
    invalid(`input?.focus();`),
    invalid(`ref.current?.focus();`),
    invalid(`svg.focus();`),
    // Even with preventScroll: the funnel is the one spelling.
    invalid(`el.focus({ preventScroll: true });`),
  ],
});
