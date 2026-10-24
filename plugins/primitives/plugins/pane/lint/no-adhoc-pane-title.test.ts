/**
 * Tests for the `no-adhoc-pane-title` lint rule. Run with `./equin test`.
 *
 * The rule flags a `<Text variant>` in the JSX returned by a same-file component
 * referenced as `Pane.define({ title: { component: X } })` — the pane title
 * item already wraps it in the canonical `label` baseline.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-adhoc-pane-title";

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

// `RuleTester.run` drives bun:test's ambient describe/it, so it must run at
// module top level — never wrapped in a `test()` callback.
ruleTester.run(
  "no-adhoc-pane-title",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // A title component that inherits the baseline.
      {
        code: `
          function CrumbTitle() {
            return <span className="font-medium">Crumb</span>;
          }
          export const pane = Pane.define({
            title: { useText: "Crumb", component: CrumbTitle },
          });
        `,
      },
      // `<Text>` without a variant inherits too.
      {
        code: `
          const CrumbTitle = () => <Text as="span">Crumb</Text>;
          export const pane = Pane.define({
            title: { useText: "Crumb", component: CrumbTitle },
          });
        `,
      },
      // A component NOT referenced as a pane title may size its text freely.
      {
        code: `
          function Body() {
            return <Text variant="title">Big</Text>;
          }
          export const pane = Pane.define({ title: "Crumb", component: Body });
        `,
      },
      // `title: { component }` outside Pane.define is not a pane title.
      {
        code: `
          function Heading() {
            return <Text variant="title">Big</Text>;
          }
          export const card = defineCard({ title: { component: Heading } });
        `,
      },
      // An imported component is not traced (accepted false negative).
      {
        code: `
          import { CrumbTitle } from "./crumb-title";
          export const pane = Pane.define({
            title: { useText: "Crumb", component: CrumbTitle },
          });
        `,
      },
      // A nested function's returned JSX is not the component's.
      {
        code: `
          function CrumbTitle() {
            const renderTip = () => <Text variant="caption">tip</Text>;
            return <span>{useLabel()}</span>;
          }
          export const pane = Pane.define({
            title: { useText: "Crumb", component: CrumbTitle },
          });
        `,
      },
    ],
    invalid: [
      // Function declaration.
      {
        code: `
          function CrumbTitle() {
            return (
              <span>
                <Text variant="title">Crumb</Text>
              </span>
            );
          }
          export const pane = Pane.define({
            title: { useText: "Crumb", component: CrumbTitle },
          });
        `,
        errors: [{ messageId: "adhocPaneTitle" }],
      },
      // Const arrow with an expression body; two offenders.
      {
        code: `
          const CrumbTitle = () => (
            <>
              <Text variant="label">A</Text>
              <Text variant="caption">B</Text>
            </>
          );
          export const pane = Pane.define({
            title: { useText: "Crumb", component: CrumbTitle },
          });
        `,
        errors: [
          { messageId: "adhocPaneTitle" },
          { messageId: "adhocPaneTitle" },
        ],
      },
      // Each return branch is checked; the component is reported once even when
      // two panes reference it.
      {
        code: `
          function CrumbTitle() {
            if (useMissing()) return <Text variant="label">Missing</Text>;
            return <span>ok</span>;
          }
          export const a = Pane.define({ title: { component: CrumbTitle } });
          export const b = Pane.define({ title: { component: CrumbTitle } });
        `,
        errors: [{ messageId: "adhocPaneTitle" }],
      },
    ],
  },
);
