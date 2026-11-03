/**
 * Tests for `bun-sync-settle-matchers`: in a file importing `bun:test`, an
 * awaited `expect(…).rejects` / `.resolves` matcher is reported and the `await`
 * removed, and `.rejects/.resolves.toSatisfy` (bun hands its predicate the
 * promise) is reported; the bare statement, other awaits, and vitest files stay valid.
 */

import rule from "./bun-sync-settle-matchers";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const BUN = `import { expect, test } from "bun:test";\n`;
const VITEST = `import { expect, test } from "vitest";\n`;
const err = [{ messageId: "awaitedSettleMatcher" as const }];

ruleTester.run("bun-sync-settle-matchers", rule, {
  valid: [
    { code: `${BUN}expect(p).rejects.toThrow("boom");` },
    { code: `${BUN}expect(p).resolves.toBe(1);` },
    { code: `${BUN}async function f() { await p; expect(x).toBe(1); }` },
    { code: `${BUN}async function f() { await other(p).rejects.toThrow(); }` },
    { code: `${BUN}expect(x).toSatisfy((v) => v > 1);` },
    {
      code: `${VITEST}async function f() { await expect(p).rejects.toSatisfy(ok); }`,
    },
    // vitest's `.rejects` is a real promise: awaiting it is right.
    {
      code: `${VITEST}async function f() { await expect(p).rejects.toThrow(); }`,
    },
  ],
  invalid: [
    {
      code: `${BUN}async function f() { await expect(p).rejects.toThrow("boom"); }`,
      errors: err,
      output: `${BUN}async function f() { expect(p).rejects.toThrow("boom"); }`,
    },
    {
      code: `${BUN}async function f() { await expect(p).resolves.toEqual({ a: 1 }); }`,
      errors: err,
      output: `${BUN}async function f() { expect(p).resolves.toEqual({ a: 1 }); }`,
    },
    {
      code: `${BUN}async function f() { await expect(p).rejects.not.toThrow(); }`,
      errors: err,
      output: `${BUN}async function f() { expect(p).rejects.not.toThrow(); }`,
    },
    {
      code: `${BUN}expect(p).rejects.toSatisfy((e) => e.code === "E");`,
      errors: [{ messageId: "settledToSatisfy" as const }],
    },
    {
      code: `${BUN}expect(p).resolves.not.toSatisfy(ok);`,
      errors: [{ messageId: "settledToSatisfy" as const }],
    },
  ],
});
