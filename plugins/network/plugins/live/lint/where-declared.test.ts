/**
 * Tests for the `where-declared` lint rule. Type-aware: the harness is
 * `no-endpoint-read.test.ts`'s — each case is linted as a virtual
 * `web/case.tsx` under an inferred project (`tsconfig.case.json`). The live
 * barrel does not resolve there, so {@link PRELUDE} declares a minimal
 * `useLive`, a where type and a tree builder; the rule reads only the call's
 * name and the query argument's type.
 */

import { setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./where-declared";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const WEB_CASE = "web/case.tsx";
const WEB = `${LINT_DIR}/${WEB_CASE}`;

const PRELUDE = `
type Where = { flag?: boolean; n?: number };
interface Tree { readonly or: readonly Where[] }
declare const c: { key: "c" };
declare function useLive(c: unknown, q: unknown): unknown;
declare function useOptimisticResource(c: unknown, q: unknown, o: unknown): unknown;
declare function or(...w: Where[]): Tree;
declare const cond: boolean;
`;

const web = (code: string) => ({ filename: WEB, code: PRELUDE + code });
const undeclared = (name = "useLive") => ({
  messageId: "undeclared",
  data: { name },
});

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      projectService: {
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [WEB_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

ruleTester.run(
  "where-declared",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Written in the call: tsc excess-checks it there.
      web(`useLive(c, { where: { flag: true } });`),
      web(`useLive(c, { where: cond ? { flag: true } : { n: 1 } });`),
      web(`useLive(c, cond ? { where: { flag: true } } : { limit: 2 });`),
      web(`useLive(c, { count: true, ...(cond ? { where: { n: 1 } } : {}) });`),
      // Declared with its where type.
      web(`const w: Where = { flag: true }; useLive(c, { where: w });`),
      web(
        `const where: Where = cond ? { flag: true } : { n: 1 }; useLive(c, { where });`,
      ),
      web(`function f(w: Where) { return useLive(c, { where: w }); }`),
      // A tree: built by a typed function.
      web(`const t = or({ flag: true }); useLive(c, { where: t });`),
      // No where.
      web(`const q = { limit: 2 }; useLive(c, q);`),
      web(`useLive(c, { id: "a" });`),
    ],
    invalid: [
      {
        ...web(`const w = { flag: true }; useLive(c, { where: w });`),
        errors: [undeclared()],
      },
      {
        ...web(`const where = { flag: true, nope: 1 }; useLive(c, { where });`),
        errors: [undeclared()],
      },
      // A hoisted union: one branch names the bad column.
      {
        ...web(
          `const where = cond ? { nope: 1 } : { flag: true }; useLive(c, { where });`,
        ),
        errors: [undeclared()],
      },
      // Through a query built before the call.
      {
        ...web(`const q = { where: { flag: true } }; useLive(c, q);`),
        errors: [undeclared()],
      },
      // A function's inferred return.
      {
        ...web(
          `function build() { return { flag: true }; } useLive(c, { where: build() });`,
        ),
        errors: [undeclared()],
      },
      {
        ...web(
          `const w = { flag: true }; useOptimisticResource(c, { where: w }, {});`,
        ),
        errors: [undeclared("useOptimisticResource")],
      },
    ],
  },
);
