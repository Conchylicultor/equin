/**
 * Tests for the `no-adhoc-row` lint rule. Run with `./equin test
 * plugins/primitives/plugins/css/plugins/row`.
 *
 * The first invalid case under "fingerprint B" is the acceptance test the second
 * fingerprint exists for: `PanelActionRow` as it stood before
 * `research/2026-08-17-global-row-usable-below-icon-button.md` — `Row`'s chrome
 * hand-copied onto `<Line as="button">` to route around an import cycle. It
 * escaped fingerprint A twice over (a capitalized host tag, and `p-row` counting
 * as a sanctioned padding escape), which is exactly why B keys on `p-row` as a
 * SIGNAL rather than an escape.
 *
 * The primitive itself trips B by construction — no class-level test can tell
 * `Row` from an exact copy of `Row` — so it is exempted by path in `lint/index.ts`,
 * not in the rule. Nothing here asserts that; the glob is the contract.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-row";

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
  "no-adhoc-row",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // — fingerprint A: sanctioned escapes —
      // Composed through the primitive.
      `const a = <Row size="sm" onClick={f}>x</Row>;`,
      // Named padding tokens that are NOT Row's own stay pure escapes.
      `const a = <button className="rounded-md p-card hover:bg-muted">x</button>;`,
      `const a = <span className="rounded-md p-chip hover:bg-muted">x</span>;`,
      // Positioned overlay escapes structurally.
      `const a = <div className="absolute rounded-md px-2 py-1 hover:bg-muted">x</div>;`,
      // Rounded + small pad but no interactive signal — that is the chip rule's half.
      `const a = <span className="rounded-md px-2 py-1">x</span>;`,
      // Capitalized host tag with no p-row — fingerprint A skips components.
      `const a = <Line className="rounded-md px-2 py-1 hover:bg-muted">x</Line>;`,

      // — fingerprint B: p-row alone is not the row shape —
      // A row's padding with no interactive signal (e.g. a display container).
      `const a = <Line className="p-row text-body">x</Line>;`,
      // `w-full` without `text-left` is not enough on its own.
      `const a = <Line className="w-full p-row">x</Line>;`,
    ],
    invalid: [
      // — fingerprint A —
      {
        code: `const a = <div className="rounded-md px-2 py-1 hover:bg-muted">x</div>;`,
        errors: [{ messageId: "adhocRow" }],
      },
      {
        code: `const a = <button className="w-full rounded px-3 py-1.5 text-left">x</button>;`,
        errors: [{ messageId: "adhocRow" }],
      },

      // — fingerprint B: the Row-minus-Row copy —
      // The real PanelActionRow, as it stood. Component host tag + p-row: both
      // of fingerprint A's escapes, so only B catches it.
      {
        code:
          `const a = <Line as="button" className={cn(` +
          `"w-full gap-sm rounded-md p-row text-left text-body",` +
          `"hover:bg-muted/50 disabled:pointer-events-none")}>x</Line>;`,
        errors: [{ messageId: "rowCopy" }],
      },
      // The hover tint alone is enough.
      {
        code: `const a = <Line className="p-row hover:bg-accent">x</Line>;`,
        errors: [{ messageId: "rowCopy" }],
      },
      // So is `w-full` + `text-left`, for a copy with no hover state.
      {
        code: `const a = <Line className="w-full p-row text-left">x</Line>;`,
        errors: [{ messageId: "rowCopy" }],
      },
      // B fires on intrinsic tags too, and takes precedence over A — one report,
      // and it is the one that names the actual mistake.
      {
        code: `const a = <div className="w-full rounded-md p-row text-left hover:bg-muted">x</div>;`,
        errors: [{ messageId: "rowCopy" }],
      },
      // Tokens split across cn() fragments still aggregate into one Set.
      {
        code: `const a = <Line className={cn("p-row", active && "hover:bg-accent")}>x</Line>;`,
        errors: [{ messageId: "rowCopy" }],
      },
    ],
  },
);
