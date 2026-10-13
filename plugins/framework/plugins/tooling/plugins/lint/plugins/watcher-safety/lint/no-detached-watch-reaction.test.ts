/**
 * Tests for `watcher-safety/no-detached-watch-reaction`. Typed RuleTester
 * harness copied from `plugins/framework/plugins/hook-value/lint` — each case is
 * a VIRTUAL `case.ts` under an inferred project (`tsconfig.case.json`).
 */

import { describe, it, setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-detached-watch-reaction";

// The first case pays for building the inferred program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.ts";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

/** The reaction types, declared inline as the engine spells them. */
const PRELUDE = `
type WatchReaction<E> = (events: E[]) => void | Promise<void>;
type WatchReconcile = () => void | Promise<void>;
declare function start(opts: {
  onChange: WatchReaction<string>;
  onReconcile?: WatchReconcile;
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

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      projectService: {
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [VIRTUAL_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

ruleTester.run(
  "no-detached-watch-reaction",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Returned work: the watch coalesces it.
      valid(`start({ onChange: () => work() });`),
      valid(`start({ onChange: async () => { await work(); } });`),
      valid(`start({ onChange: () => work(), onReconcile: () => work() });`),
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
        `start({ onChange: () => notify(), onReconcile: () => { void work(); } });`,
      ),
      invalid(
        `start({ onChange: (events) => { if (events.length > 0) void work(); } });`,
      ),
    ],
  },
);
