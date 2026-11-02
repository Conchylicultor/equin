/**
 * Tests for the `no-adhoc-prettier` lint rule. Run with `bun test`.
 *
 * The rule bans reaching prettier outside `tooling/format`, which owns the
 * allowlist and the hardcoded options the whole repo's byte-format identity
 * rests on. It fires on (A) an import / dynamic import / require of `prettier`
 * or a `prettier/*` subpath, (B) a `spawn` / `spawnSync` whose argv array
 * literal invokes the prettier CLI, and (C) a string / template used as a
 * `prettier …` shell command.
 *
 * Invalid `code` embeds the token inside a JS string (preceded by a `"` quote,
 * never a shell separator), and the bare module name has no trailing
 * whitespace, so the command-position anchor means this test file is not
 * self-flagged — no allowlist entry for it is needed.
 */

import rule from "./no-adhoc-prettier";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-prettier", rule, {
  valid: [
    // The sanctioned route.
    {
      code: `import { formatSource } from "@plugins/framework/plugins/tooling/plugins/format/core";`,
    },
    // A package whose name merely starts with the same letters.
    { code: `import x from "prettier-ignore-helper";` },
    // Other CLIs spawned via bunx/npx are unrelated.
    { code: `Bun.spawn(["bunx", "tsc", "--noEmit"]);` },
    { code: `spawnSync(["git", "add", "-A"]);` },
    // Prose mentioning the tool mid-sentence (not a command position).
    {
      code: `const doc = "route formatting through prettier's one chokepoint";`,
    },
    // The bare module name as data — no trailing whitespace, so not a command.
    { code: `const name = "prettier";` },
  ],
  invalid: [
    // Case A: static import, subpath import, dynamic import, require.
    {
      code: `import * as fmt from "prettier";`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    {
      code: `import { format } from "prettier/standalone";`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    {
      code: `const mod = await import("prettier");`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    {
      code: `const mod = require("prettier");`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    // Case B: a spawn argv invoking the CLI, bare and via bunx / npx.
    {
      code: `Bun.spawn(["prettier", "--write", "src"]);`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    {
      code: `spawnCaptured(["bunx", "prettier", "--check", "."]);`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    {
      code: `spawnSync(["npx", "prettier", "-w", "file.ts"]);`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    // Case C: a string literal used as a shell command, incl. after a separator.
    {
      code: `const cmd = "prettier --write src"; run(cmd);`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    {
      code: `const cmd = "bun install && npx prettier --check ."; run(cmd);`,
      errors: [{ messageId: "adhocPrettier" }],
    },
    // Case C (template form). `code` is a plain string so it can embed
    // backticks; it carries no `${…}` because `no-template-curly-in-string`
    // flags an interpolation written inside an ordinary string.
    {
      code: "const cmd = `prettier --write src`;",
      errors: [{ messageId: "adhocPrettier" }],
    },
  ],
});
