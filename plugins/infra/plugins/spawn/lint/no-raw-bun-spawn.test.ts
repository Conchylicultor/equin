/**
 * Tests for the `no-raw-bun-spawn` lint rule. Run with `bun test`.
 *
 * The rule is a chokepoint ban on the `Bun.spawn` member expression itself —
 * calls, aliasing, and the computed `Bun["spawn"]` form — because even an
 * option-less `Bun.spawn(argv)` defaults stdout to "pipe" and is exposed to
 * the bun 1.3.13 exit-during-stream-pull wedge. `Bun.spawnSync` buffers
 * natively and stays valid, as does prose that merely mentions the token
 * inside a string.
 *
 * The spawn plugin itself (where raw Bun.spawn IS the impl) is exempted by its
 * own exempt/index.ts, honored for every manifest in lint/core's
 * `exemptions-honored.test.ts` — the rule names no owner, so it fires there.
 */

import rule from "./no-raw-bun-spawn";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-raw-bun-spawn", rule, {
  valid: [
    // spawnSync buffers natively — no JS streams, no wedge; explicitly legal.
    { code: `Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);` },
    // Other Bun members are unrelated.
    { code: `const f = Bun.file("/tmp/x");` },
    // The sanctioned door.
    { code: `await spawnCaptured(["git", "status"]);` },
    // Prose that merely mentions the token inside a string.
    { code: `const doc = "prefer spawnCaptured over a raw Bun.spawn call";` },
  ],
  invalid: [
    // Inside the spawn plugin: silenced by spawn/exempt/index.ts, not the rule.
    {
      code: `Bun.spawn(["echo", "hi"], { stdout: outFd });`,
      filename: "plugins/infra/plugins/spawn/core/internal/spawn-captured.ts",
      errors: [{ messageId: "rawBunSpawn" }],
    },
    // The plain call — including option-less (stdout defaults to "pipe").
    {
      code: `Bun.spawn(["git", "status"]);`,
      errors: [{ messageId: "rawBunSpawn" }],
    },
    {
      code: `const proc = Bun.spawn(["echo", "hi"], { stdout: "pipe" });`,
      errors: [{ messageId: "rawBunSpawn" }],
    },
    // Aliasing — the member access alone is the exposure.
    {
      code: `const s = Bun.spawn; s(["echo", "hi"]);`,
      errors: [{ messageId: "rawBunSpawn" }],
    },
    // Computed form.
    {
      code: `Bun["spawn"](["echo", "hi"]);`,
      errors: [{ messageId: "rawBunSpawn" }],
    },
  ],
});
