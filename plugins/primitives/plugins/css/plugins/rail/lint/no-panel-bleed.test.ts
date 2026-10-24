/**
 * Tests for the `no-panel-bleed` lint rule. Run with `./equin test`.
 *
 * The `valid` cases are the shapes that must NEVER trip it, and each is a real
 * one: a band INSIDE a panel bleeding (the sanctioned fix, and what the three
 * ex-`padded={false}` dialogs were migrated to), a panel carrying any other
 * class, and a token that merely starts with the same letters.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-panel-bleed";

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

// `RuleTester.run` drives bun:test's ambient describe/it, so it must run at
// module top level — never wrapped in a `test()` callback.
ruleTester.run(
  "no-panel-bleed",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // THE sanctioned shape: the panel keeps its region, a band inside bleeds.
      {
        code: `const el = <DialogContent size="lg"><div className="rail-bleed border-b">{header}</div></DialogContent>;`,
      },
      // A hairline bleeding inside a menu — `SelectSeparator`'s actual shape.
      {
        code: `const el = <SelectContent><div className="rail-bleed my-1 h-px" /></SelectContent>;`,
      },
      // A panel with an ordinary className.
      { code: `const el = <PopoverContent className="w-64" />;` },
      // A panel with no className at all.
      {
        code: `const el = <OverlayPanel padding="md">{children}</OverlayPanel>;`,
      },
      // Token match is exact — a longer class that merely shares the prefix is
      // not the escape.
      { code: `const el = <DialogContent className="rail-bleed-x" />;` },
      // Not a panel surface: an ordinary element may carry the escape.
      { code: `const el = <div className="rail-bleed">{row}</div>;` },
      // `rail-bleed` reached through a const is out of scope on purpose — the
      // rule reads one element's own class expression, no alias resolution.
      {
        code: `const FLUSH = "rail-bleed"; const el = <DialogContent className={FLUSH} />;`,
      },
    ],
    invalid: [
      // The muscle-memory replacement for the deleted `padded={false}`.
      {
        code: `const el = <DialogContent className="rail-bleed" />;`,
        errors: [{ messageId: "panelBleed" }],
      },
      // Through `cn()`, which is how a className is actually composed here.
      {
        code: `const el = <PopoverContent className={cn("rail-bleed", className)} />;`,
        errors: [{ messageId: "panelBleed" }],
      },
      // The pattern-matched member of the set.
      {
        code: `const el = <DropdownMenuSubContent className="rail-bleed" />;`,
        errors: [{ messageId: "panelBleed" }],
      },
      // The panel primitive itself.
      {
        code: `const el = <OverlayPanel className="rail-bleed" padding="lg" />;`,
        errors: [{ messageId: "panelBleed" }],
      },
      // Conditionally applied is still applied.
      {
        code: `const el = <SelectContent className={flush ? "rail-bleed" : "p-md"} />;`,
        errors: [{ messageId: "panelBleed" }],
      },
      // The control-panel surface, whose whole point is that width and padding
      // are roles with no escape.
      {
        code: `const el = <ControlPanelPopover size="menu" className="rail-bleed" />;`,
        errors: [{ messageId: "panelBleed" }],
      },
    ],
  },
);
