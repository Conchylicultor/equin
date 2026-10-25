/**
 * Tests for the `no-unanimated-surface-exit` lint rule: a floating surface
 * behind a bare conditional is flagged; the same conditional inside
 * `<Presence>`, an in-flow or decorative element, and an unconditional
 * surface are not.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-unanimated-surface-exit";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

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

const error = [{ messageId: "unanimatedSurfaceExit" as const }];

// `RuleTester.run` registers bun:test cases, so it runs at module top level.
ruleTester.run(
  "no-unanimated-surface-exit",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      `const a = <Presence>{open ? <Pin key="c" to="right" layer="float"><Card/></Pin> : null}</Presence>;`,
      `const a = <Presence>{open && <Surface level="overlay">x</Surface>}</Presence>;`,
      // Not floating: in-flow surfaces and decorative pins.
      `const a = open ? <Surface level="raised">x</Surface> : null;`,
      `const a = open && <Pin to="top-right" decorative><Dot/></Pin>;`,
      `const a = open && <Pin to="top" layer="raised">x</Pin>;`,
      // A floating pin holding only controls is not a surface.
      `const a = index > 0 ? <Pin to="left" layer="float"><IconButton/></Pin> : null;`,
      // Unconditional.
      `const a = <Pin to="right" layer="float">x</Pin>;`,
      // A swap between two markups is not an exit.
      `const a = open ? <Pin layer="float">a</Pin> : <Pin layer="float">b</Pin>;`,
    ],
    invalid: [
      {
        code: `const a = open && <Pin to="right" layer="float"><Surface level="overlay">x</Surface></Pin>;`,
        errors: error,
      },
      {
        code: `const a = a && b && <Placed x={1} y={2} layer="overlay"><div><Surface level="float">x</Surface></div></Placed>;`,
        errors: error,
      },
      {
        code: `const a = open ? <Surface level="overlay">x</Surface> : null;`,
        errors: error,
      },
      {
        code: `const a = closed ? undefined : <Surface level={"float"}>x</Surface>;`,
        errors: error,
      },
      {
        code: `const a = open ? <ViewportOverlay>x</ViewportOverlay> : null;`,
        errors: error,
      },
      {
        code: `const a = <div>{open && <Surface level="overlay">x</Surface>}</div>;`,
        errors: error,
      },
    ],
  },
);
