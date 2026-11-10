/**
 * Tests for the `no-pane-header-bar` lint rule. Run with `bun test`.
 *
 * The rule flags a `<Bar tier="pane">` — the pane header's own tier, drawn only
 * by `PaneChrome`. Other tiers, other elements and a dynamic tier are fine.
 */
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-pane-header-bar";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-pane-header-bar", rule, {
  valid: [
    { code: `const el = <Bar tier="subpane" />;` },
    { code: `const el = <Bar />;` },
    { code: `const el = <Bar tier="chrome" className="x" />;` },
    // A dynamic tier is not the literal the rule fingerprints.
    { code: `const el = <Bar tier={tier} />;` },
    // Another element carrying the attribute is not the Bar primitive.
    { code: `const el = <Tabs tier="pane" />;` },
    { code: `const DOC = '<Bar tier="pane">';` },
  ],
  invalid: [
    {
      code: `const el = <Bar tier="pane" className="border-b-0">x</Bar>;`,
      errors: [{ messageId: "paneHeaderBar" }],
    },
    {
      code: `const el = <Bar tier={"pane"} />;`,
      errors: [{ messageId: "paneHeaderBar" }],
    },
    {
      code: `const el = <Bar className="a" tier="pane" as="header" />;`,
      errors: [{ messageId: "paneHeaderBar" }],
    },
  ],
});
