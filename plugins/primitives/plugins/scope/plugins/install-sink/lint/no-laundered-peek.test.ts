/**
 * Tests for the `no-laundered-peek` lint rule. Run with
 * `./equin test plugins/primitives/plugins/install-sink`.
 *
 * The rule bans an exported module-scope function whose returned expression
 * contains a `peek…()` call, unless the function is already named `peek…` or is
 * a hook. It must NOT fire on a function that merely ACTS on a peeked value, on
 * a returned closure that peeks lazily, or on a non-exported local helper.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-laundered-peek";

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

ruleTester.run(
  "no-laundered-peek",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // ACTS on the peeked value; returns nothing. Not laundering a sample into a
      // render-readable fact.
      {
        code: `
        export function navigateApp(url) {
          appNavSink.peekOrThrow()(url);
        }
      `,
      },
      // Already honest about being a one-shot sample.
      {
        code: `
        export function peekAdapter() {
          return historySink.peek();
        }
      `,
      },
      // A hook is the sanctioned render-path read.
      {
        code: `
        export function useAdapter() {
          return historySink.peek() ?? defaultAdapter;
        }
      `,
      },
      // Not exported — no cross-file laundering surface.
      {
        code: `
        function canNavigateApp() {
          return appNavSink.peek() !== null;
        }
      `,
      },
      // A RETURNED CLOSURE that peeks later: the scan stops at the function
      // boundary, so this deferred shape is not flagged.
      {
        code: `
        export function makeNavigator() {
          return () => appNavSink.peek();
        }
      `,
      },
      // Same, as a concise arrow returning an arrow.
      {
        code: `
        export const makeNavigator = () => () => appNavSink.peek();
      `,
      },
      // The pure shape the rule steers toward: the value is a PARAMETER, so the
      // function cannot sample at all.
      {
        code: `
        export function placementIsNewTabFollows(capabilities, id) {
          return capabilities?.newTabFollows.has(id) ?? false;
        }
      `,
      },
      // No peek anywhere.
      {
        code: `
        export function getUserName(user) {
          return user.name;
        }
      `,
      },
    ],
    invalid: [
      // The bare forward, exactly as the incident was spelled.
      {
        code: `
        export function canNavigateApp() {
          return appNavSink.peek() !== null;
        }
      `,
        errors: [{ messageId: "launderedPeek" }],
      },
      // The plain return.
      {
        code: `
        export function currentAdapter() {
          return historySink.peek();
        }
      `,
        errors: [{ messageId: "launderedPeek" }],
      },
      // The DERIVED getter the repo audit turned up — one derivation deeper, same
      // hazard.
      {
        code: `
        export function placementIsNewTabFollows(id) {
          return placementSink.peek()?.newTabFollows.has(id) ?? false;
        }
      `,
        errors: [{ messageId: "launderedPeek" }],
      },
      // Boolean negation of a peek.
      {
        code: `
        export const hasNoNavigator = () => !appNavSink.peek();
      `,
        errors: [{ messageId: "launderedPeek" }],
      },
      // Double negation, concise-arrow body.
      {
        code: `
        export const canNavigate = () => !!appNavSink.peek();
      `,
        errors: [{ messageId: "launderedPeek" }],
      },
      // `export const f = function () {…}` form, undefined comparison.
      {
        code: `
        export const isInstalled = function () {
          return appNavSink.peek() !== undefined;
        };
      `,
        errors: [{ messageId: "launderedPeek" }],
      },
      // Bare identifier peek, inside a conditional branch's return.
      {
        code: `
        export function adapterOrDefault(flag) {
          if (flag) return peekHistoryAdapter();
          return defaultAdapter;
        }
      `,
        errors: [{ messageId: "launderedPeek" }],
      },
    ],
  },
);
