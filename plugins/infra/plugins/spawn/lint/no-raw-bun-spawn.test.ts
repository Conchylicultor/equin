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
 * This test file itself lives under the spawn plugin dir (the in-rule owner
 * skip) AND matches the test-file ignore, so it is doubly exempt at lint time;
 * the RuleTester below runs the rule against synthetic filenames.
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
    // The owner skip: inside the spawn plugin, raw Bun.spawn IS the impl.
    {
      code: `Bun.spawn(["echo", "hi"], { stdout: outFd });`,
      filename: "plugins/infra/plugins/spawn/core/internal/spawn-captured.ts",
    },
  ],
  invalid: [
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
