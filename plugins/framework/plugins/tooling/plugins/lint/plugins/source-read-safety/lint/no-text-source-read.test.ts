/**
 * Tests for `no-text-source-read`: parse-utils' source-text helpers are
 * reported in a `check/` folder's code, and left alone everywhere else.
 */

import rule from "./no-text-source-read";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const CHECK = "/repo/plugins/foo/check/index.ts";
const PU = `"@plugins/plugin-meta/plugins/parse-utils/core"`;

ruleTester.run("no-text-source-read", rule, {
  valid: [
    // Outside a check/ folder (a codegen scan, a facet).
    {
      code: `import { maskSource } from ${PU};`,
      filename: "/repo/plugins/foo/core/a.scan.ts",
    },
    // A plugin NAMED check is not a check/ folder.
    {
      code: `import { findImports } from ${PU};`,
      filename: "/repo/plugins/framework/plugins/cli/plugins/check/cli/run.ts",
    },
    // Not a text read.
    {
      code: `import { lineAt, runWithFsSnapshot } from ${PU};`,
      filename: CHECK,
    },
    // Types only.
    { code: `import type { ImportRef } from ${PU};`, filename: CHECK },
    { code: `import { type ImportRef } from ${PU};`, filename: CHECK },
    { code: `export type { ImportRef } from ${PU};`, filename: CHECK },
    // Another barrel.
    {
      code: `import { sourceAnalysis } from "@plugins/framework/plugins/tooling/plugins/checks/core";`,
      filename: CHECK,
    },
    {
      code: `import { grepCode, grepImports } from "@plugins/framework/plugins/tooling/plugins/checks/core";`,
      filename: CHECK,
    },
  ],
  invalid: [
    {
      code: `import { maskedSource, sourceAnalysis } from "@plugins/framework/plugins/tooling/plugins/checks/core";`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
    {
      code: `import { maskSource, lineAt, matchBracket } from ${PU};`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }, { messageId: "textRead" }],
    },
    {
      code: `import { findImports } from ${PU};`,
      filename: "/repo/plugins/a/plugins/b/check/foo.scan.ts",
      errors: [{ messageId: "textRead" }],
    },
    {
      code: `import * as pu from ${PU};`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
    {
      code: `export { findMarkerCalls } from ${PU};`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
    {
      code: `export * from ${PU};`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
    {
      code: `import * as cc from "@plugins/framework/plugins/tooling/plugins/checks/core"; cc.maskedSource(s); cc.sourceAnalysis(ctx);`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
    {
      code: `export * from "@plugins/framework/plugins/tooling/plugins/checks/core";`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
    {
      code: "const m = await import(`@plugins/plugin-meta/plugins/parse-utils/core`);",
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
    {
      code: `const m = await import(${PU});`,
      filename: CHECK,
      errors: [{ messageId: "textRead" }],
    },
  ],
});
