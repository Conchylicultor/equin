/**
 * Tests for `watcher-safety/no-detached-watch-reaction`. A typed rule test:
 * each case is a VIRTUAL `case.ts` under an inferred project
 * (`createTypedRuleTester` in `tooling/lint/core/testing`).
 */

import { setDefaultTimeout } from "bun:test";
import { createTypedRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-detached-watch-reaction";

// The first case pays for building the inferred program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

/** The reaction types, declared inline as the engine spells them. */
const PRELUDE = `
type WatchReaction<E> = (events: E[]) => void | Promise<void>;
type WatchLost = (dir: string, error: unknown) => void | Promise<void>;
declare function start(opts: {
  onChange: WatchReaction<string>;
  onLost?: WatchLost;
}): void;
declare function work(): Promise<void>;
declare function notify(): void;
declare function later(fn: () => void): void;
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string, count = 1) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: Array.from({ length: count }, () => ({ messageId: "detached" })),
});

const ruleTester = createTypedRuleTester({
  dir: LINT_DIR,
  cases: [VIRTUAL_CASE],
});

ruleTester.run("no-detached-watch-reaction", rule, {
  valid: [
    // Returned work: the watch coalesces it.
    valid(`start({ onChange: () => work() });`),
    valid(`start({ onChange: async () => { await work(); } });`),
    valid(`start({ onChange: () => work(), onLost: () => work() });`),
    // Sync reactions.
    valid(`start({ onChange: () => notify() });`),
    valid(
      `const seen: string[] = []; start({ onChange: (e) => void seen.push(...e) });`,
    ),
    // A detach inside a NESTED function is that function's business.
    valid(`start({ onChange: () => later(() => { void work(); }) });`),
    // Not a watch callback.
    valid(`later(() => { void work(); });`),
    // Module scope: no enclosing function at all.
    valid(`void work();`),
  ],
  invalid: [
    invalid(`start({ onChange: () => { void work(); } });`),
    invalid(`start({ onChange: () => void work() });`),
    invalid(
      `start({ onChange: () => notify(), onLost: () => { void work(); } });`,
    ),
    invalid(
      `start({ onChange: (events) => { if (events.length > 0) void work(); } });`,
    ),
  ],
});
