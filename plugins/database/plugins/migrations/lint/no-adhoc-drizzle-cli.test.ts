/**
 * Tests for the `no-adhoc-drizzle-cli` lint rule. Run with `bun test`.
 *
 * This rule replaced a repo-wide TEXT check that paired each occurrence of the
 * binary's name with the nearest subcommand token within 8 lines. That heuristic
 * could not tell an argv element from a string literal, and it failed the build
 * on a `Set` of command names in guards/poll-detect.ts that invoked nothing
 * (`research/2026-08-08-global-drizzle-cli-argv-owner.md`).
 *
 * So the FIRST valid case below is the regression this rule exists to not
 * repeat: naming the binary as data must be invisible. The rule reports only
 * where the name reaches a spawn's argv — a syntactic position, not a proximity
 * guess.
 */

import rule from "./no-adhoc-drizzle-cli";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-drizzle-cli", rule, {
  valid: [
    // THE regression case: a table of command names invokes nothing.
    {
      code: `const MUTATING = new Set(["git", "rm", "drizzle-kit", "psql"]);`,
    },
    // Prose in a message or a hint.
    {
      code: `const hint = "never run drizzle-kit push against this config";`,
    },
    // The npm PACKAGE, not the CLI.
    { code: `import { defineConfig } from "drizzle-kit";` },
    { code: `const c = require("drizzle-kit");` },
    // An argv array that is never spawned — a fixture, a doc example.
    {
      code: `const example = [process.execPath, "x", "--bun", "drizzle-kit", "push"];`,
    },
    // The sanctioned door: the owner builds the argv, this site passes flags.
    {
      code: `await spawnCaptured(drizzleGenerateArgv({ custom: true }), { cwd });`,
    },
    // The owner module itself — it IS the invocation.
    {
      code: `export const DRIZZLE_KIT_BIN = "drizzle-kit";`,
      filename:
        "plugins/database/plugins/migrations/core/internal/drizzle-cli.ts",
    },
    // A different binary in a real spawn.
    { code: `await spawnCaptured(["git", "status"], { cwd });` },
  ],
  invalid: [
    // Inline argv, straight into the chokepoint.
    {
      code: `await spawnCaptured([process.execPath, "x", "--bun", "drizzle-kit", "push"], { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    // Even the allowed subcommand: the argv still has one owner.
    {
      code: `await spawnExpectOk(["drizzle-kit", "generate"], { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    // The variable form both real call sites used before the owner existed.
    {
      code: `const cmd = [process.execPath, "x", "--bun", "drizzle-kit"]; cmd.push("migrate"); await spawnCaptured(cmd, { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    // Appended onto an argv declared above.
    {
      code: `const cmd = [process.execPath, "x"]; cmd.push("drizzle-kit", "studio"); await spawnCaptured(cmd, { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    // The raw forms spawn-safety still permits in server trees / tests.
    {
      code: `Bun.spawn(["drizzle-kit", "pull"], { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    {
      code: `Bun.spawnSync(["drizzle-kit", "up"], { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    // A template literal is the same string.
    {
      code: 'await spawnPassthrough([`drizzle-kit`, "migrate"], { cwd });',
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    // Namespace-style member call.
    {
      code: `await spawn.spawnCaptured(["drizzle-kit", "push"], { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
    // Reference declared in an enclosing scope.
    {
      code: `const cmd = ["bun"]; function go() { cmd.push("drizzle-kit"); } await spawnCaptured(cmd, { cwd });`,
      errors: [{ messageId: "adhocDrizzleCli" }],
    },
  ],
});
