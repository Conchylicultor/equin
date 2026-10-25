/**
 * Tests for the `no-laundered-checkout-namespace` lint rule. Run with `bun test`.
 *
 * The rule bans `asNamespace(...)` around a checkout NAME — `checkoutWorktreeName(…)`
 * or a bare `basename(…)` — including when the name reaches the cast through a
 * `??` fallback or a ternary, which is how the one live instance in the e2e
 * harness was written. `asNamespace` itself stays valid everywhere it is used as
 * the documented boundary cast (a DB column, a URL host, a spec-dir entry name),
 * and both helpers stay valid on their own; only the composition is banned.
 *
 * Fixtures are RuleTester `code` STRINGS, so this file's own AST holds no real
 * `asNamespace` call and the rule does not flag its own tests. That matters more
 * here than for most rules: this one is opted into test and e2e files via
 * `enforceEverywhere`, precisely because the bug it closes was written in an e2e
 * file.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-laundered-checkout-namespace";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level.
ruleTester.run(
  "no-laundered-checkout-namespace",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The boundary cast doing its job: a literal, a DB column, a URL host.
      { code: `const ns = asNamespace("${MAIN_WORKTREE_NAME}");` },
      { code: `const ns = asNamespace(row.worktree);` },
      { code: `const ns = asNamespace(url.host.split(".")[0]);` },
      // A spec-directory entry name really is a namespace — the cast is on the
      // NAME the listing yielded, not on a basename of a path.
      { code: `for (const name of listWorktreeDirs()) asNamespace(name);` },
      // The mint, which is what the message points at.
      { code: `const ns = namespaceFor(MAIN_COMPOSITION_ID, ref);` },
      { code: `const ns = await checkoutNamespace(root);` },
      // Both helpers are fine on their own — only casting their result is banned.
      { code: `const name = checkoutWorktreeName(root);` },
      { code: `const dir = basename(root);` },
      // The non-throwing twin is the right read for a directory scan: one stray
      // directory name is skipped rather than taking the whole scan down.
      { code: `if (isNamespace(basename(dir))) keep(dir);` },
      // Some other cast around the same name is a different rule's business (or
      // nobody's) — this one is about the Namespace brand specifically.
      { code: `const id = asPluginId(basename(dir));` },
      // Documented blind spot, recorded rather than claimed as safe: a
      // syntactic rule cannot follow a binding, and every live instance was
      // written as the direct nesting. Rung 4 (resolveCheckoutDeploy refusing
      // when no deploy answers) is what covers the indirect spelling.
      {
        code: `const name = checkoutWorktreeName(root); const ns = asNamespace(name);`,
      },
    ],
    invalid: [
      // web-artifacts/check/index.ts — the checked-in instance.
      {
        code: `const dist = worktreeArtifacts.webDist(asNamespace(checkoutWorktreeName(root)));`,
        errors: [{ messageId: "launderedCheckoutName" }],
      },
      // e2e-harness/e2e/target.ts — the defect itself. The laundering sits on
      // the right of a `??`, which is why the rule steps through fallbacks.
      {
        code: `const name = asNamespace(process.env.SINGULARITY_WORKTREE ?? checkoutWorktreeName(REPO_ROOT));`,
        errors: [{ messageId: "launderedCheckoutName" }],
      },
      // The same value with the helper's name filed off.
      {
        code: `const ns = asNamespace(basename(REPO_ROOT));`,
        errors: [{ messageId: "launderedPathSegment" }],
      },
      {
        code: `const ns = asNamespace(env ?? basename(REPO_ROOT));`,
        errors: [{ messageId: "launderedPathSegment" }],
      },
      // `path.basename(...)` — the member spelling reaches the same function.
      {
        code: `const ns = asNamespace(path.basename(root));`,
        errors: [{ messageId: "launderedPathSegment" }],
      },
      // The cast taken through a namespace import of the namespace barrel.
      {
        code: `const ns = ns_.asNamespace(checkoutWorktreeName(root));`,
        errors: [{ messageId: "launderedCheckoutName" }],
      },
      // A ternary is a fallback with a different spelling; both branches are
      // values the cast can actually receive, so both are reported.
      {
        code: `const ns = asNamespace(useHelper ? checkoutWorktreeName(a) : basename(b));`,
        errors: [
          { messageId: "launderedCheckoutName" },
          { messageId: "launderedPathSegment" },
        ],
      },
      // A type assertion between the cast and the name changes nothing.
      {
        code: `const ns = asNamespace(checkoutWorktreeName(root) as string);`,
        errors: [{ messageId: "launderedCheckoutName" }],
      },
    ],
  },
);
