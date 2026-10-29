/**
 * Tests for the `no-adhoc-control` lint rule's hand-rolled-button fingerprint
 * (fixed height + horizontal padding + rounded, on the element's own box).
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-control";

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

// `RuleTester.run` drives the test harness itself, so it runs at module top level.
ruleTester.run(
  "no-adhoc-control",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // An underline tab: the height and radius are the ::after indicator's.
      {
        code: `const C = () => <button className="relative px-3 after:absolute after:h-0.5 after:rounded-full">x</button>;`,
      },
      // A descendant's size is not the button's.
      {
        code: `const C = () => <button className="px-2 rounded [&>svg]:size-4">x</button>;`,
      },
      // An icon-only close button has no fixed height or horizontal padding.
      { code: `const C = () => <button className="p-0.5 rounded">x</button>;` },
      // Not a raw button/a.
      { code: `const C = () => <div className="h-7 px-3 rounded">x</div>;` },
    ],
    invalid: [
      {
        code: `const C = () => <button className="h-7 px-3 rounded">x</button>;`,
        errors: [{ messageId: "adhocControl" }],
      },
      // A condition on the element is still the element's own shape.
      {
        code: `const C = () => <a className="md:h-7 px-3 hover:rounded-md">x</a>;`,
        errors: [{ messageId: "adhocControl" }],
      },
      {
        code: `import { buttonVariants } from "@/components/ui/button";`,
        errors: [{ messageId: "noButtonVariants" }],
      },
    ],
  },
);
