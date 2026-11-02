/**
 * Tests for the `no-adhoc-path-resolve` lint rule. Run with `bun test`.
 *
 * The rule bans VALUE imports from `node:path` (and bare `path`) inside
 * `guards/core/guards/**`, so that every filesystem path a guard compares comes
 * out of `core/argv.ts` rather than being built from a guessed operand. Type-only
 * imports stay valid, and the rule is inert outside that directory — it is
 * configured repo-wide, so the self-limit is what keeps it from firing on the
 * thousands of files that legitimately import `join`.
 *
 * Filenames are supplied via the RuleTester `filename` option, which is what the
 * directory short-circuit reads. The two production exemptions (`main-edits.ts`,
 * `git-diff-main.ts`) are NOT tested here: they are declared in `guards/exempt/index.ts`
 * manifest, which the root eslint config applies — the rule itself flags them, and
 * a case asserting otherwise would encode the wrong contract.
 */

import rule from "./no-adhoc-path-resolve";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const GUARD =
  "/repo/plugins/framework/plugins/tooling/plugins/guards/core/guards/main-writes.ts";
const ARGV =
  "/repo/plugins/framework/plugins/tooling/plugins/guards/core/argv.ts";
const ELSEWHERE = "/repo/plugins/build/server/internal/run-build.ts";

ruleTester.run("no-adhoc-path-resolve", rule, {
  valid: [
    // Naming a path TYPE costs nothing — only holding the constructor does.
    {
      code: `import type { ParsedPath } from "node:path";`,
      filename: GUARD,
    },
    // Same, as an inline type specifier.
    {
      code: `import { type ParsedPath } from "node:path";`,
      filename: GUARD,
    },
    // The sanctioned source: operands the argv grammar already resolved.
    {
      code: `import { parseArgv, redirectionTargets } from "../argv"; parseArgv(call);`,
      filename: GUARD,
    },
    // `core/argv.ts` is the ONE file that may build a path — it is one level
    // up from the fenced directory, so the short-circuit lets it through.
    {
      code: `import { resolve } from "node:path"; resolve(cwd, arg);`,
      filename: ARGV,
    },
    // The rule is configured repo-wide; everywhere else it must be inert.
    {
      code: `import { join, resolve } from "node:path"; join(a, b);`,
      filename: ELSEWHERE,
    },
    // A same-named import from somewhere else is not the path builtin.
    {
      code: `import { join } from "./local-utils"; join(a, b);`,
      filename: GUARD,
    },
  ],
  invalid: [
    // The reported bug's mechanism: resolve() applied to a guessed operand.
    {
      code: `import { resolve } from "node:path"; resolve(call.cwd, arg);`,
      filename: GUARD,
      errors: [{ messageId: "adhocPath" }],
    },
    // Bare `path` resolves to the same builtin and must not slip through.
    {
      code: `import { join } from "path"; join(a, b);`,
      filename: GUARD,
      errors: [{ messageId: "adhocPath" }],
    },
    // `normalize` is the same constructor by another name.
    {
      code: `import { normalize } from "node:path";`,
      filename: GUARD,
      errors: [{ messageId: "adhocPath" }],
    },
    // A default import reaches every constructor at once.
    {
      code: `import path from "node:path"; path.resolve(a, b);`,
      filename: GUARD,
      errors: [{ messageId: "adhocPath" }],
    },
    // So does a namespace import.
    {
      code: `import * as path from "node:path"; path.join(a, b);`,
      filename: GUARD,
      errors: [{ messageId: "adhocPath" }],
    },
    // The value half of a mixed import is still flagged; the type half is not.
    {
      code: `import { type ParsedPath, resolve } from "node:path";`,
      filename: GUARD,
      errors: [{ messageId: "adhocPath" }],
    },
    // Every value specifier is its own violation.
    {
      code: `import { join, resolve } from "node:path";`,
      filename: GUARD,
      errors: [{ messageId: "adhocPath" }, { messageId: "adhocPath" }],
    },
  ],
});
