/**
 * Tests for the `no-adhoc-repo-walk` lint rule. Run with `bun test`.
 *
 * The rule bans the hand-written list of build-output directory names that
 * every ad-hoc repo walk begins with. It fires on an array or `new Set([...])`
 * containing `"node_modules"` TOGETHER WITH a build-output companion
 * (`"dist"`, `".git"`, `".cache"`, …).
 *
 * The pairing is what makes it precise: `"node_modules"` alone appears in
 * plenty of legitimate code (path building, resolution tests), and it is the
 * enumeration of several such directories together that means "I am about to
 * decide for myself what counts as source" — the decision that belongs to git.
 */

import rule from "./no-adhoc-repo-walk";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-repo-walk", rule, {
  valid: [
    // `node_modules` alone: a path segment, not a deny-list.
    { code: `const p = join(root, "node_modules", pkg);` },
    { code: `const SKIP = new Set(["node_modules"]);` },
    // Paired with names that are not build output — a bounded walk of a known
    // subtree, which is a different thing and stays legal.
    {
      code: `const SKIP = new Set(["node_modules", "__tests__", "public"]);`,
    },
    // Build-output names WITHOUT the anchor: not the deny-list shape.
    { code: `const OUT = ["dist", "build"];` },
    // Prose mentioning the names.
    { code: `const doc = "we skip node_modules and dist when walking";` },
  ],
  invalid: [
    {
      // The exact shape this change deleted from type-check, twice.
      code: `const IGNORED_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);`,
      errors: [{ messageId: "adhocRepoWalk" }],
    },
    {
      code: `const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git"]);`,
      errors: [{ messageId: "adhocRepoWalk" }],
    },
    {
      // A bare array, not a Set.
      code: `const skip = ["node_modules", "dist"];`,
      errors: [{ messageId: "adhocRepoWalk" }],
    },
    {
      // Passed straight to a helper rather than bound to a name.
      code: `walkTree(root, ["node_modules", ".cache"]);`,
      errors: [{ messageId: "adhocRepoWalk" }],
    },
    {
      // Reported ONCE — the Set, not the Set and its inner array.
      code: `const s = new Set(["node_modules", ".git", "dist"]);`,
      errors: [{ messageId: "adhocRepoWalk" }],
    },
  ],
});
