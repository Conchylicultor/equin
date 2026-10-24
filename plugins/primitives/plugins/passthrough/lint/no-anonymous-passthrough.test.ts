/**
 * Tests for the `no-anonymous-passthrough` lint rule. Run with
 * `./equin test plugins/primitives/plugins/passthrough`.
 *
 * The rule is purely syntactic, so this needs no TS program — unlike its
 * sibling `no-unanchored-passthrough`, whose test builds one.
 *
 * The valid cases are the calibration that matters: nine types in this repo
 * carry `[key: string]: unknown` for unrelated reasons (durable event payloads,
 * the plugin `Contribution` records) and must stay untouched, and the
 * `Passthrough` marker itself has to be able to declare the one index signature
 * the whole contract is built on. All of them are exempt by the same
 * construction — the rule fires only on a declaration named `*Props` — so there
 * is no allowlist anywhere, and these cases are what pins that.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-anonymous-passthrough";

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

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level — never inside
// test().
ruleTester.run(
  "no-anonymous-passthrough",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The sanctioned spelling: the bag and the node it lands on, together.
      `interface BadgeProps extends Passthrough { children: React.ReactNode }`,
      // Narrower ref for a primitive whose node is not just an HTMLElement.
      `interface OverlayPanelProps extends Passthrough<HTMLDivElement> { header?: React.ReactNode }`,
      // The marker itself — not named `*Props`, so it can declare the one index
      // signature the contract is built on without tripping its own rule.
      `interface Passthrough<E extends HTMLElement = HTMLElement> { ref?: React.Ref<E>; [key: string]: unknown }`,
      // Durable event payloads: open bags of DATA, nothing spreads them onto an
      // element, and there is no node for a `ref` to name.
      `export interface ConversationTurnCompletedPayload { conversationId: string; [key: string]: unknown }`,
      `export interface RefAdvancedPayload { ref: string; [key: string]: unknown }`,
      // Plugin contribution records, same reasoning.
      `export interface ServerContribution { slot: string; [key: string]: unknown }`,
      // A props type with no passthrough at all.
      `interface RowProps { selected?: boolean; children: React.ReactNode }`,
      // A dictionary-shaped FIELD inside a props type is not the props
      // passthrough — only the declaration's own body is read.
      `interface ChartProps { series: { [key: string]: unknown }; height: number }`,
      // A narrower value type describes a dictionary the component reads, not a
      // bag it spreads onto an element.
      `interface StyleProps { [token: string]: string }`,
      // Not a declaration the rule can name: an inline parameter type.
      `function render(props: { [key: string]: unknown }) { return props; }`,
    ],
    invalid: [
      // The shape `Row` shipped: open, and silent about where the bag lands.
      {
        code: `interface RowProps { children: React.ReactNode; [key: string]: unknown }`,
        errors: [{ messageId: "anonymousPassthrough" }],
      },
      // A type alias declares it the same way.
      {
        code: `type LineProps = { as?: string; [key: string]: unknown };`,
        errors: [{ messageId: "anonymousPassthrough" }],
      },
      // `any` is the other spelling of the open bag.
      {
        code: `interface SurfaceProps { level?: string; [key: string]: any }`,
        errors: [{ messageId: "anonymousPassthrough" }],
      },
      // The index parameter's name is arbitrary — the shape is what matters.
      {
        code: `interface TabProps { active?: boolean; [prop: string]: unknown }`,
        errors: [{ messageId: "anonymousPassthrough" }],
      },
      // Extending `Passthrough` AND re-declaring the signature is still an
      // anonymous passthrough sitting in the file.
      {
        code: `interface CardProps extends Passthrough { [key: string]: unknown }`,
        errors: [{ messageId: "anonymousPassthrough" }],
      },
    ],
  },
);
