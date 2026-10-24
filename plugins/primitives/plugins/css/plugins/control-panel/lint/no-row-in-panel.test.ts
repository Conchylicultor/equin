/**
 * Tests for the `no-row-in-panel` lint rule. Run with `./equin test
 * plugins/primitives/plugins/css/plugins/control-panel`.
 */
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-row-in-panel";

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

ruleTester.run("no-row-in-panel", rule as never, {
  valid: [
    // A Row outside any panel is the generic row doing its job.
    `function List() { return <Stack><Row onClick={f}>x</Row></Stack>; }`,
    // The panel's own row.
    `function P() { return <ControlPanel><ControlPanel.Row onSelect={f}>x</ControlPanel.Row></ControlPanel>; }`,
    // A Row in a different component from the panel is out of this rule's reach.
    `function Item() { return <Row onClick={f}>x</Row>; }
     function P() { return <ControlPanel.Section><Item /></ControlPanel.Section>; }`,
  ],
  invalid: [
    {
      code: `function P() { return <ControlPanel.Section><Row onClick={f}>x</Row></ControlPanel.Section>; }`,
      errors: [{ messageId: "rowInPanel" }],
    },
    {
      // Through an inline `.map()` callback: the same JSX tree.
      code: `function P() { return <ControlPanelPopover trigger={t}>{xs.map((x) => <Row key={x}>{x}</Row>)}</ControlPanelPopover>; }`,
      errors: [{ messageId: "rowInPanel" }],
    },
  ],
});
