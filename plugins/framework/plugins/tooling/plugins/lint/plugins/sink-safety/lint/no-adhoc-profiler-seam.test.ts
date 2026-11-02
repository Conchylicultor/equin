/**
 * Tests for the `no-adhoc-profiler-seam` lint rule. Run with `bun test`.
 *
 * The rule bans importing the runtime-profiler observation seams (onSlowSpan /
 * captureFlightWindow / readGateGauges) from the profiler core barrel. The
 * sanctioned owners (slow-ops, trace/spans, stall-monitor, profiling/runtime, …)
 * declare it in their own exempt/index.ts — honored for every manifest in
 * lint/core's `exemptions-honored.test.ts`; the rule itself names none. The sibling pull APIs on the SAME barrel
 * (getRuntimeProfile, registerGateGauge) stay valid, as do type-only imports and
 * relative imports (the profiler's own internals).
 *
 * Fixtures embed the imports as RuleTester `code` STRINGS, so this test file's own
 * AST holds no real seam import — it is not self-flagged.
 */

import rule from "./no-adhoc-profiler-seam";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const CORE = "@plugins/infra/plugins/runtime-profiler/core";

ruleTester.run("no-adhoc-profiler-seam", rule, {
  valid: [
    // The sanctioned pull API on the same barrel.
    {
      code: `import { getRuntimeProfile } from "${CORE}"; getRuntimeProfile();`,
    },
    // The gauge PRODUCER side — ~5 legit callers.
    { code: `import { registerGateGauge } from "${CORE}";` },
    // A mixed import: allowed names only.
    { code: `import { getRuntimeProfile, registerGateGauge } from "${CORE}";` },
    // Type-only import of a seam never loads a value.
    { code: `import type { onSlowSpan } from "${CORE}";` },
    // Relative import (the profiler's own internals import via ./recorder).
    { code: `import { onSlowSpan } from "./recorder";` },
  ],
  invalid: [
    // An owner's own file: the rule fires — slow-ops/exempt/index.ts is what
    // silences it, so the rule carries no owner list to drift.
    {
      code: `import { onSlowSpan } from "${CORE}";`,
      filename:
        "/repo/plugins/debug/plugins/slow-ops/server/internal/install-slow-span.ts",
      errors: [{ messageId: "adhocSeam" }],
    },
    // A second onSlowSpan subscriber outside the owners.
    {
      code: `import { onSlowSpan } from "${CORE}";`,
      filename:
        "/repo/plugins/debug/plugins/my-new-monitor/server/internal/hook.ts",
      errors: [{ messageId: "adhocSeam" }],
    },
    // captureFlightWindow outside an owner.
    {
      code: `import { captureFlightWindow } from "${CORE}";`,
      filename: "/repo/plugins/debug/plugins/elsewhere/server.ts",
      errors: [{ messageId: "adhocSeam" }],
    },
    // A banned seam alongside an allowed sibling — only the seam is reported.
    {
      code: `import { getRuntimeProfile, readGateGauges } from "${CORE}";`,
      filename: "/repo/plugins/debug/plugins/elsewhere/server.ts",
      errors: [{ messageId: "adhocSeam" }],
    },
    // Namespace import + seam member access.
    {
      code: `import * as prof from "${CORE}"; prof.onSlowSpan(cb);`,
      filename: "/repo/plugins/debug/plugins/elsewhere/server.ts",
      errors: [{ messageId: "adhocSeam" }],
    },
  ],
});
