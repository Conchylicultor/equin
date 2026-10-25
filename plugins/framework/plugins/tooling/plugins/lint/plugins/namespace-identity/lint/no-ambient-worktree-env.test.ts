/**
 * Tests for the `no-ambient-worktree-env` lint rule. Run with `bun test`.
 *
 * The rule bans the retired `SINGULARITY_WORKTREE` name from code anywhere but
 * the one transition file, whether it is written as an identifier
 * (`process.env.SINGULARITY_WORKTREE`, an `env:` key, a destructuring) or as the
 * bare string (`process.env["SINGULARITY_WORKTREE"]`).
 *
 * Fixtures are RuleTester `code` STRINGS, so the name inside them is one token
 * of a longer template and this file's own AST holds no bare occurrence — which
 * matters more here than for most rules, since the rule is opted into test files
 * via `enforceEverywhere`.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-ambient-worktree-env";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-ambient-worktree-env",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The two replacements, which is what the message points at.
      { code: `const ns = runtimeNamespace();` },
      { code: `const ns = await checkoutNamespace(root);` },
      // Passing identity to a child the sanctioned way.
      { code: `argv.push("--namespace", runtimeNamespace());` },
      // Every OTHER product environment variable is somebody else's
      // business — this rule is about the one retired name.
      { code: `if (process.env.SINGULARITY_RELEASE === "1") boot();` },
      { code: `process.env.SINGULARITY_DIR ??= fallback;` },
      // A name that merely CONTAINS it is a different variable.
      { code: `const v = process.env.SINGULARITY_WORKTREE_LEGACY;` },
    ],
    invalid: [
      // The plain read.
      {
        code: `const wt = process.env.SINGULARITY_WORKTREE;`,
        errors: [{ messageId: "ambientWorktreeEnv" }],
      },
      // The write — the half that creates the inheritance in the first place.
      {
        code: `process.env.SINGULARITY_WORKTREE = name;`,
        errors: [{ messageId: "ambientWorktreeEnv" }],
      },
      // Handing it to a child as a spawn `env` key.
      {
        code: `spawn(argv, { env: { ...process.env, SINGULARITY_WORKTREE: basename(root) } });`,
        errors: [{ messageId: "ambientWorktreeEnv" }],
      },
      // Bun's alias reaches the same variable.
      {
        code: `const wt = Bun.env.SINGULARITY_WORKTREE;`,
        errors: [{ messageId: "ambientWorktreeEnv" }],
      },
      // The computed spelling.
      {
        code: `const wt = process.env["SINGULARITY_WORKTREE"];`,
        errors: [{ messageId: "ambientWorktreeEnv" }],
      },
      // The delete, which is how the old value-scoped scrub was written.
      {
        code: `delete env.SINGULARITY_WORKTREE;`,
        errors: [{ messageId: "ambientWorktreeEnv" }],
      },
      // The backend entry is no longer exempt: it used to carry the one
      // transition read while a pre-argv gateway could still be running, and
      // that gateway has been restarted.
      {
        code: `const legacy = process.env.SINGULARITY_WORKTREE;`,
        filename:
          "/repo/plugins/framework/plugins/server-core/bin/declare-namespace.ts",
        errors: [{ messageId: "ambientWorktreeEnv" }],
      },
    ],
  },
);
