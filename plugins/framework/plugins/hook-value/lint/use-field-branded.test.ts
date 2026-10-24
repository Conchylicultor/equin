/**
 * Tests for `hook-value/use-field-branded`. Run with
 * `./equin test plugins/framework/plugins/hook-value`.
 *
 * Same typed RuleTester harness as `hook-binding-name.test.ts` (see
 * `plugins/primitives/plugins/passthrough/lint/no-unanchored-passthrough.test.ts`
 * for why it is shaped this way).
 */

import { describe, it, setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./use-field-branded";

// The first case pays for building the inferred program (seconds); every case
// after it is milliseconds. bun:test's default five-second budget is too tight.
setDefaultTimeout(60_000);

/** This directory — where `tsconfig.case.json` and the virtual case both sit. */
const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** The path every case is linted AS — nothing exists there (see the harness notes). */
const VIRTUAL_CASE = "case.tsx";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

/**
 * The brand, declared inline: the virtual case cannot import. Kept the shape of
 * `core/internal/hook.ts`, so the suite pins the property name the rules read.
 */
const PRELUDE = `
type Hook<F extends (...args: never[]) => unknown> = F & { readonly __hook?: true };
declare function useState<T>(v: T): [T, (v: T) => void];
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string, messageIds: string[]) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: messageIds.map((messageId) => ({ messageId })),
});

// Hand RuleTester bun:test's describe/it explicitly: it only picks up ambient
// globals, and without them it runs every case at import time — failures still
// throw, but the run reports "0 tests" and names no case.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
      projectService: {
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [VIRTUAL_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

ruleTester.run(
  "use-field-branded",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      valid(`interface Spec { useX: Hook<() => number> }`),
      valid(`type Spec = { useX?: Hook<(s: string) => boolean> }`),
      // A string-or-hook union: the only callable member is branded.
      valid(`interface Title { useText: string | Hook<() => string> }`),
      // Non-function use* fields are not hooks.
      valid(`interface Opts { useCache: boolean; use2x?: number | null }`),
      // Not a hook name (`user`, `usage`): no capital after `use`.
      valid(`interface Opts { user: () => string; usage(): number }`),
      // Out of scope: function declarations and object literals.
      valid(`
        export function useFoo() { return 1; }
        const mock = { useFoo: () => 2 };`),
    ],
    invalid: [
      invalid(`interface Spec { useFoo: () => number }`, ["unbrandedField"]),
      invalid(`type Spec = { useFoo?: (x: string) => boolean }`, [
        "unbrandedField",
      ]),
      // A union whose callable member lacks the brand.
      invalid(`interface Title { useText: string | (() => string) }`, [
        "unbrandedField",
      ]),
      // Component props types count like any other type literal.
      invalid(
        `export function G(props: { useStatus: () => string }) { return props; }`,
        ["unbrandedField"],
      ),
      // A method signature cannot carry the brand at all.
      invalid(`interface Slot { useContributions(): string[] }`, [
        "methodSignature",
      ]),
    ],
  },
);
