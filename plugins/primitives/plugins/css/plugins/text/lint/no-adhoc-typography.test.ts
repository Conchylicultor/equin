/**
 * Tests for the `no-adhoc-typography` lint rule. Run with `bun test`:
 *
 *   bun test plugins/primitives/plugins/text/lint/no-adhoc-typography.test.ts
 *
 * The focus is the class-token walk's alias resolution: a banned
 * `text-*`/`leading-*` parked in a MAP indexed in a class context
 * (`cn(TONE[tone])`, `styles.title`), in a string `const`, behind an
 * intermediate local, or returned through a same-file helper must be flagged,
 * while doc-strings, sanctioned sub-scale classes, member/key NAMES, and
 * param-passed classNames (no in-file initializer) must NOT be.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-typography";

const rule = buildRule(lintToolkit);

// Hand RuleTester bun's own describe/it, or it registers nothing under
// `./equin test`.
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

// `RuleTester.run` drives the test harness itself (through the describe/it
// handed to it above), so it must run at module top level — never wrapped in a
// `test()` callback.
ruleTester.run(
  "no-adhoc-typography",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // A doc string / unrelated literal not in any class-name context: the walk
      // never starts here, so `text-sm` in prose is never inspected.
      { code: `const note = "use text-sm instead of raw sizes";` },
      // Color + sanctioned sub-scale in a map that reaches className: harvested,
      // but neither `text-muted-foreground` (color) nor `text-2xs` (sub-scale)
      // is a banned named size.
      {
        code: `
          const M = { a: "text-muted-foreground text-2xs" };
          const C = () => <span className={cn(M.a)} />;
        `,
      },
      // A param-passed className has no in-file initializer to read, so the
      // alias resolution finds nothing to harvest.
      {
        code: `
          function C({ className }: { className?: string }) {
            return <div className={cn("flex", className)} />;
          }
        `,
      },
      // A member NAME is not an alias: `.box` never resolves the same-file
      // `box` binding.
      {
        code: `
          const box = "text-sm";
          const M = { box: "text-caption" };
          const C = () => <span className={M.box} />;
        `,
      },
      // A `cva` table is walked, but its variant NAMES and `defaultVariants`
      // values are not classes: roles in the values pass, and a same-file
      // binding that shares a variant name (`size`) is never resolved as an
      // alias of that key.
      {
        code: `
          const size = "text-sm";
          const v = cva("flex", {
            variants: { size: { sm: "text-caption", lg: "text-body" } },
            defaultVariants: { size: "sm" },
          });
        `,
      },
    ],
    invalid: [
      // `cva` is a class builder: its base string AND each variant value are
      // classes. One CallExpression visit, two banned tokens → 2 errors.
      {
        code: `const v = cva("text-sm", { variants: { size: { a: "text-xs" } } });`,
        errors: [
          { messageId: "adhocTypography" },
          { messageId: "adhocTypography" },
        ],
      },
      // A bare string `const` alias IS followed. It used to be deliberately
      // skipped, because the consts that shape carried in practice were shared
      // mono/code metrics with no role to move to. There is one now (`code`), and
      // skipping the shape had a cost the exemption didn't pay for: hoisting a
      // class string into a const was a way OUT of every class rule, and at least
      // one site was hoisted for exactly that reason, saying so in a comment.
      // One error, not two: the identifier is reached only via the JSXAttribute
      // handler — there is no cn() call here for the CallExpression handler.
      {
        code: `
          const cls = "text-sm";
          const C = () => <div className={cls} />;
        `,
        errors: [{ messageId: "adhocTypography" }],
      },
      // Tone object-MAP const indexed into cn() in JSX. `TONE` resolves to an
      // object literal, so both values (`text-xs`, `text-sm`) are harvested via
      // the dynamic index `TONE[t]`. The cn call is visited TWICE — once by the
      // JSXAttribute handler (on className's value) and once by the
      // CallExpression handler — so each banned token reports twice:
      // 2 tokens x 2 visits = 4 errors.
      {
        code: `
          const TONE = { muted: "text-xs text-muted-foreground", loud: "text-sm" };
          function C({ t }: { t: keyof typeof TONE }) {
            return <span className={cn("flex", TONE[t])} />;
          }
        `,
        errors: [
          { messageId: "adhocTypography" },
          { messageId: "adhocTypography" },
          { messageId: "adhocTypography" },
          { messageId: "adhocTypography" },
        ],
      },
      // A styling-function RESULT is not followed: `buttonVariants` is bound to
      // a cva(...) call, which is a check site of its own — the table reports
      // once where it is written, never again at each use. 1 error, not 2.
      {
        code: `
          const buttonVariants = cva("text-sm");
          const C = () => <button className={buttonVariants()} />;
        `,
        errors: [{ messageId: "adhocTypography" }],
      },
      // A map reached through an INTERMEDIATE LOCAL is followed: `sz` stands for
      // its initializer `SIZE[s]`, which resolves `SIZE`. 1 error.
      {
        code: `
          const SIZE = { a: { box: "text-xs" } };
          function C({ s }: { s: keyof typeof SIZE }) {
            const sz = SIZE[s];
            return <span className={sz.box} />;
          }
        `,
        errors: [{ messageId: "adhocTypography" }],
      },
      // A map returned through a HELPER is followed (the avatar's SIZE_MAP hid
      // this way): `sz` stands for `geometryFor(...)`, whose callee stands for
      // its return values — both branches of the ternary. 2 tokens → 2 errors.
      {
        code: `
          const SIZE = { sm: { box: "text-xs" }, md: { box: "text-sm" } };
          const TILE = { box: "size-full" };
          function geometryFor(tile: boolean, s: keyof typeof SIZE) {
            if (tile) return TILE;
            return SIZE[s];
          }
          function C({ s }: { s: keyof typeof SIZE }) {
            const sz = geometryFor(false, s);
            return <span className={sz.box} />;
          }
        `,
        errors: [
          { messageId: "adhocTypography" },
          { messageId: "adhocTypography" },
        ],
      },
      // An arrow-bound helper is followed the same way, called inline.
      {
        code: `
          const pick = (loud: boolean) => (loud ? "text-lg" : "text-caption");
          const C = () => <span className={pick(true)} />;
        `,
        errors: [{ messageId: "adhocTypography" }],
      },
      // Member access into an object-literal MAP: resolving `styles` harvests the
      // whole object literal, which carries the banned `text-lg`. Only the
      // JSXAttribute handler fires (no cn) → 1 error.
      {
        code: `
          const styles = { title: "text-lg" };
          const C = () => <h1 className={styles.title} />;
        `,
        errors: [{ messageId: "adhocTypography" }],
      },
    ],
  },
);
