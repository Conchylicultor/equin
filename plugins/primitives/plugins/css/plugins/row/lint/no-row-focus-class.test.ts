/**
 * Tests for the `no-row-focus-class` lint rule. Run with `./equin test
 * plugins/primitives/plugins/css/plugins/row`.
 *
 * The second invalid case is the acceptance test the rule exists for: the
 * `sub-page-block` row as it stood — `outline-none` plus an `isFocused &&
 * "ring-primary/30 ring-1"` caret cue, authored on the row box that `Row` stops
 * focusing the day the row gains an action.
 *
 * The primitive itself carries the real treatment (`focus-ring` +
 * `focus-ring-from`) and so trips the rule by construction — it is exempted by
 * path in `lint/index.ts`, not in the rule. Nothing here asserts that; the glob
 * is the contract.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-row-focus-class";

const rule = buildRule(lintToolkit);

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

// `RuleTester.run` drives the harness itself (calls the ambient describe/it that
// bun:test provides), so it must run at module top level — never inside test().
ruleTester.run(
  "no-row-focus-class",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Ordinary layout/text classes on a Row.
      `const a = <Row className="w-full text-left" />;`,
      // The sanctioned vocabulary for "this is the current row".
      `const a = <Row selected />;`,
      // Not a Row — the rule polices the two row components only.
      `const a = <div className="ring-1" />;`,
      // Aggregated cn() fragments with nothing focus-shaped in them.
      `const a = <Row className={cn("gap-sm", active && "bg-muted")} />;`,
    ],
    invalid: [
      {
        code: `const a = <Row className="outline-none" />;`,
        errors: [{ messageId: "rowFocusClass" }],
      },
      // The real sub-page shape: tokens split across cn() fragments and a
      // conditional still aggregate into one Set, and report once.
      {
        code: `const a = <Row className={cn("outline-none", isFocused && "ring-primary/30 ring-1")} />;`,
        errors: [{ messageId: "rowFocusClass" }],
      },
      // A focus variant is enough on its own.
      {
        code: `const a = <Row className="focus-visible:ring-2" />;`,
        errors: [{ messageId: "rowFocusClass" }],
      },
      // …anywhere in the variant chain.
      {
        code: `const a = <Row className="dark:focus-visible:outline-2" />;`,
        errors: [{ messageId: "rowFocusClass" }],
      },
      // Arbitrary variant whose selector text mentions focus — the `:` inside
      // the brackets must not shred the split.
      {
        code: `const a = <Row className="has-[:focus-visible]:ring-3" />;`,
        errors: [{ messageId: "rowFocusClass" }],
      },
      // The section-header row splits the same way.
      {
        code: `const a = <SectionHeaderRow className="ring-1" />;`,
        errors: [{ messageId: "rowFocusClass" }],
      },
    ],
  },
);
