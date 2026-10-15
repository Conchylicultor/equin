/**
 * Tests for `no-unanchored-has`: each Tailwind variant naming a `:has()` is
 * translated to the selector Tailwind v4 compiles it to (checked against
 * `compile()` output) and rejected when a compound at or after the `:has()`
 * names no element.
 */

import { describe, expect, test } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule, { variantSelector } from "./no-unanchored-has";

describe("variantSelector mirrors Tailwind v4's output", () => {
  test.each([
    ["has-[:focus]", "&:has(*:is(:focus))"],
    ["not-has-[.x]", "&:not(*:has(*:is(.x)))"],
    ["group-has-[:active]/x", "&:is(:where(.group\\/x):has(*:is(:active)) *)"],
    ["group-not-has-[.x]", "&:is(:where(.group):not(*:has(*:is(.x))) *)"],
    ["peer-has-[:checked]", "&:is(:where(.peer):has(*:is(:checked)) ~ *)"],
    ["in-[.a:has(.b)]", ":where(*:is(.a:has(.b))) &"],
    ["[&_:has(.x)]", "& :has(.x)"],
    ["[.a:has(.b)_*]", "&:is(.a:has(.b) *)"],
    ["[.a\\_b]", "&:is(.a_b)"],
    ["hover", "&"],
  ])("%s → %s", (variant, selector) => {
    expect(variantSelector(variant)).toBe(selector);
  });
});

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

const err = [{ messageId: "unanchoredHas" }];

ruleTester.run(
  "no-unanchored-has",
  // The flat-config RuleTester is typed against the legacy Rule shape; the
  // typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      `<div className="has-[[data-x]]:overflow-x-auto" />`,
      `<div className="has-[:focus-visible]:ring-2" />`,
      `<div className="not-has-[.x]:block" />`,
      `<div className="in-[.a:has(.b)]:block" />`,
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
      { code: `<div className="group-not-has-[.x]:block" />`, errors: err },
      { code: `<div className="peer-has-[:checked]:block" />`, errors: err },
      { code: `<div className="[&_:has(.x)]:block" />`, errors: err },
      { code: `<div className="[.a:has(.b)_*]:block" />`, errors: err },
      { code: `<div className="[.a:has(.b)>*]:block" />`, errors: err },
      {
        code: `<div className="[&:has(.b)>:first-child]:block" />`,
        errors: err,
      },
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
