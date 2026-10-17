/**
 * Tests for the `type-aware-rule-declared` lint rule.
 *
 * A file that reads the parser services — `ESLintUtils.getParserServices`, an
 * imported `getParserServices`, `.parserServices`, or a destructured
 * `{ parserServices }` — must declare `requiresTypeChecking: true` (the
 * literal) in its rule object's `meta.docs`. A file reading none is never
 * flagged, whatever its docs say.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./type-aware-rule-declared";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const ruleWith = (docs: string, body: string): string => `
export default createRule({
  name: "r",
  meta: { type: "problem", docs: ${docs}, schema: [], messages: {} },
  defaultOptions: [],
  create(context) {
    ${body}
    return {};
  },
});`;

const DECLARED = `{ description: "d", requiresTypeChecking: true }`;
const UNDECLARED = `{ description: "d" }`;
const CALL = `const s = ESLintUtils.getParserServices(context);`;

// `RuleTester.run` drives the test harness itself (it calls the ambient
// describe/it that bun:test provides), so it must run at module top level.
ruleTester.run(
  "type-aware-rule-declared",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Declared, every spelling of the read.
      { code: ruleWith(DECLARED, CALL) },
      { code: ruleWith(DECLARED, `const s = getParserServices(context);`) },
      {
        code: ruleWith(
          DECLARED,
          `const s = context.sourceCode.parserServices;`,
        ),
      },
      {
        code: ruleWith(
          DECLARED,
          `const { parserServices } = context.sourceCode;`,
        ),
      },
      // Lazily reached (no-endpoint-read's shape) — declared all the same.
      {
        code: ruleWith(
          DECLARED,
          `let services; const get = () => (services ??= ESLintUtils.getParserServices(context));`,
        ),
      },
      // A syntactic rule: no read, no declaration needed.
      { code: ruleWith(UNDECLARED, `const src = context.sourceCode;`) },
      // The name only in a string is not a read.
      { code: ruleWith(UNDECLARED, `const msg = "calls getParserServices";`) },
    ],
    invalid: [
      {
        code: ruleWith(UNDECLARED, CALL),
        errors: [{ messageId: "undeclared" }],
      },
      {
        code: ruleWith(UNDECLARED, `const s = getParserServices(context);`),
        errors: [{ messageId: "undeclared" }],
      },
      {
        code: ruleWith(
          UNDECLARED,
          `const s = context.sourceCode.parserServices;`,
        ),
        errors: [{ messageId: "undeclared" }],
      },
      {
        code: ruleWith(
          UNDECLARED,
          `const { parserServices } = context.sourceCode;`,
        ),
        errors: [{ messageId: "undeclared" }],
      },
      // Not the literal `true`: a computed flag cannot be read syntactically.
      {
        code: ruleWith(
          `{ description: "d", requiresTypeChecking: TYPED }`,
          CALL,
        ),
        errors: [{ messageId: "undeclared" }],
      },
      {
        code: ruleWith(
          `{ description: "d", requiresTypeChecking: false }`,
          CALL,
        ),
        errors: [{ messageId: "undeclared" }],
      },
      // docs not an object literal.
      {
        code: ruleWith(`DOCS`, CALL),
        errors: [{ messageId: "undeclared" }],
      },
      // The read lives in a file with no rule object to declare it on.
      {
        code: `export function typesOf(context) { return ESLintUtils.getParserServices(context).program; }`,
        errors: [{ messageId: "noRuleObject" }],
      },
    ],
  },
);
