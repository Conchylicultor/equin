/**
 * Tests for the `no-adhoc-check-runner` lint rule. Run with `bun test`.
 *
 * The rule bans the VALUE import of `runChecks` from the checks core barrel
 * everywhere except the check command's own file. The sibling exports on the SAME
 * barrel (`RunChecksOptions`, `listAllChecks`, `scopeOf`, `markBuildInProgress`)
 * stay valid, as do type-only imports.
 *
 * Fixtures embed the specifier as RuleTester `code` STRINGS, so this test file's
 * own AST holds no real `runChecks` import — it is not self-flagged (which matters
 * more here than for most rules: this one is opted into test files via
 * `enforceEverywhere`, because a suite that drives the runner writes to the same
 * global cache a later push reads). Owner short-circuiting is exercised via the
 * `filename` option.
 */

import rule from "./no-adhoc-check-runner";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const CORE = "@plugins/framework/plugins/tooling/plugins/checks/core";
const OWNER = "/repo/plugins/framework/plugins/cli/plugins/check/cli/run.ts";
const BUILD = "/repo/plugins/framework/plugins/cli/plugins/build/cli/run.ts";
const ARTIFACTS =
  "/repo/plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts";

ruleTester.run("no-adhoc-check-runner", rule, {
  valid: [
    // The ONE sanctioned in-process caller: the check command's own action.
    {
      code: `import { runChecks } from "${CORE}"; runChecks(undefined, {});`,
      filename: OWNER,
    },
    // The owner may also take the runner via a namespace import.
    {
      code: `import * as checks from "${CORE}"; checks.runChecks(undefined, {});`,
      filename: OWNER,
    },
    // Naming the options shape costs nothing — only invoking the runner does.
    {
      code: `import type { RunChecksOptions } from "${CORE}";`,
      filename: BUILD,
    },
    // Same, as an inline type specifier alongside a value import.
    {
      code: `import { type RunChecksOptions, listAllChecks } from "${CORE}";`,
      filename: BUILD,
    },
    // Unrelated value exports on the same barrel read the registry without
    // recording anything, so they are not banned.
    {
      code: `import { listAllChecks, scopeOf } from "${CORE}"; listAllChecks();`,
      filename: BUILD,
    },
    // A same-named import from somewhere else is not this seam.
    {
      code: `import { runChecks } from "./runner"; runChecks();`,
      filename: BUILD,
    },
    // Member access on a namespace of an unrelated module.
    {
      code: `import * as other from "./other"; other.runChecks();`,
      filename: BUILD,
    },
  ],
  invalid: [
    // build.ts — the caller whose contaminated process recorded a wrong
    // plugins-doc-in-sync PASS four times.
    {
      code: `import { runChecks } from "${CORE}"; await runChecks(undefined, {});`,
      filename: BUILD,
      errors: [{ messageId: "adhocRunner" }],
    },
    // internal/app-artifacts.ts — the `--skip-checks` always-run pass.
    {
      code: `import { runChecks, listAllChecks } from "${CORE}";`,
      filename: ARTIFACTS,
      errors: [{ messageId: "adhocRunner" }],
    },
    // A namespace import + member access reaches the same runner.
    {
      code: `import * as checks from "${CORE}"; checks.runChecks(undefined, {});`,
      filename: ARTIFACTS,
      errors: [{ messageId: "adhocRunner" }],
    },
    // Any other plugin — the owner is a FILE, not the bin/commands directory.
    {
      code: `import { runChecks } from "${CORE}";`,
      filename: "/repo/plugins/build/server/internal/run-build.ts",
      errors: [{ messageId: "adhocRunner" }],
    },
    // A test harness is inside the blast radius too (no test exemption).
    {
      code: `import { runChecks } from "${CORE}"; await runChecks(["type-check"], {});`,
      filename:
        "/repo/plugins/framework/plugins/tooling/plugins/checks/core/runner.test.ts",
      errors: [{ messageId: "adhocRunner" }],
    },
  ],
});
