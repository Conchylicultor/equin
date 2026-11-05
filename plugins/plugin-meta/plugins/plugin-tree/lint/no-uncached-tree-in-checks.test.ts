/**
 * Tests for the `no-uncached-tree-in-checks` lint rule.
 *
 * Fixtures embed the specifier as RuleTester `code` STRINGS, so this file's own
 * AST holds no real import. Scoping is exercised via the `filename` option.
 */

import rule from "./no-uncached-tree-in-checks";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const CORE = "@plugins/plugin-meta/plugins/plugin-tree/core";
const FACETED = "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core";
const CHECK = "/repo/plugins/tasks/plugins/foo/check/index.ts";
const RUNNER =
  "/repo/plugins/framework/plugins/tooling/plugins/checks/core/runner.ts";
const CODEGEN =
  "/repo/plugins/framework/plugins/tooling/plugins/codegen/core/barrel-free-tree.ts";
// A plugin NAMED `check` is not check code.
const CHECK_COMMAND =
  "/repo/plugins/framework/plugins/cli/plugins/check/cli/run.ts";

ruleTester.run("no-uncached-tree-in-checks", rule, {
  valid: [
    {
      code: `import { buildStructureTreeOnce } from "${CORE}"; buildStructureTreeOnce("/p");`,
      filename: CHECK,
    },
    {
      code: `import type { PluginTree } from "${CORE}";`,
      filename: CHECK,
    },
    {
      code: `import { type PluginTree, resolvePluginSpecifier } from "${CORE}";`,
      filename: RUNNER,
    },
    // The codegen memos are the builder's legitimate owners.
    {
      code: `import { buildPluginTree } from "${CORE}"; buildPluginTree("/p");`,
      filename: CODEGEN,
    },
    {
      code: `import { buildPluginTree } from "${CORE}"; buildPluginTree("/p");`,
      filename: CHECK_COMMAND,
    },
  ],
  invalid: [
    {
      code: `import { buildFacetedPluginTree } from "${FACETED}";`,
      filename: CHECK,
      errors: [{ messageId: "uncachedTree" }],
    },
    {
      code: `import * as ft from "${FACETED}"; ft.buildFacetedPluginTree("/p");`,
      filename: RUNNER,
      errors: [{ messageId: "uncachedTree" }],
    },
    {
      code: `import { buildPluginTree } from "${CORE}";`,
      filename: CHECK,
      errors: [{ messageId: "uncachedTree" }],
    },
    {
      code: `import { buildPluginTree as b } from "${CORE}";`,
      filename: RUNNER,
      errors: [{ messageId: "uncachedTree" }],
    },
    {
      code: `import * as pt from "${CORE}"; pt.buildPluginTree("/p");`,
      filename: CHECK,
      errors: [{ messageId: "uncachedTree" }],
    },
    {
      code: `import { buildPluginTree } from "${CORE}";`,
      filename:
        "/repo/plugins/framework/plugins/tooling/plugins/checks/plugins/x/check/index.ts",
      errors: [{ messageId: "uncachedTree" }],
    },
  ],
});
