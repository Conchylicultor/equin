/**
 * Tests for `no-universal-has`: Tailwind variants compiling to a `:has()`
 * followed by a universal selector are rejected; a subject `has-[…]:` and a
 * `:has()` anchored on a marked ancestor naming this element (`_&`) pass.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-universal-has";

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

const err = [{ messageId: "universalHas" }];

ruleTester.run(
  "no-universal-has",
  // The flat-config RuleTester is typed against the legacy Rule shape; the
  // typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      `<div className="has-[[data-x]]:overflow-x-auto" />`,
      `<div className="has-[:focus-visible]:ring-2" />`,
      `<div className="[[data-host]:has(:active)_&]:opacity-100" />`,
      `<div className="[[data-root]:has([data-claim])_&:not(:has([data-claim]))]:flex-initial" />`,
      `<div className="[&:has(>[data-a])>[data-b]]:pr-2" />`,
      `<div className="group-hover/x:opacity-100 group-data-[open]/x:block" />`,
      `cn("data-scroll-x-path:overflow-x-auto")`,
      // ui-kit button-group: the `:has()` sits inside `:nth-child(… of …)`; the
      // `>*` follows the outer `.contents` compound, not the `:has()`.
      `<div className="[&>.contents:nth-child(1_of_:is([data-s],.contents:has(>[data-s])))>*]:rounded-l-full" />`,
    ],
    invalid: [
      {
        code: `<div className="group-has-[:active]/x:opacity-100" />`,
        errors: err,
      },
      {
        code: `<div className="group-has-data-[sidebar=menu-action]/menu-item:pr-2xl" />`,
        errors: err,
      },
      { code: `<div className="peer-has-[:checked]:block" />`, errors: err },
      { code: `<div className="in-[.a:has(.b)]:block" />`, errors: err },
      { code: `<div className="[.a:has(.b)_*]:block" />`, errors: err },
      { code: `<div className="[.a:has(.b)>*]:block" />`, errors: err },
      {
        code: `const C = "group-has-[[data-x]]/bar:flex-initial"; cn(C);`,
        errors: err,
      },
      {
        code: `cva("hover:bg-x group-has-[:active]/g:opacity-100")`,
        errors: err,
      },
    ],
  },
);
