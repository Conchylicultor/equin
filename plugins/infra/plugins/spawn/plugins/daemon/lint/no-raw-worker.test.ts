/**
 * Tests for `no-raw-worker`: `new Worker` (bare, via globalThis, computed) is
 * reported in server / central / shared code, while CLI, check, core and test
 * code — and the daemon primitive itself — are left alone.
 */

import rule from "./no-raw-worker";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const SERVER = "/repo/plugins/foo/server/internal/host.ts";

ruleTester.run("no-raw-worker", rule, {
  valid: [
    // A check's / a command's worker thread ends with its command.
    {
      code: `new Worker(url);`,
      filename: "/repo/plugins/foo/check/prepare-thread.ts",
    },
    { code: `new Worker(url);`, filename: "/repo/plugins/foo/cli/run.ts" },
    {
      code: `new Worker(url);`,
      filename: "/repo/plugins/foo/core/thread.ts",
    },
    // Tests.
    {
      code: `new Worker(url);`,
      filename: "/repo/plugins/foo/server/a.test.ts",
    },
    // The primitive.
    {
      code: `new Worker(url);`,
      filename:
        "/repo/plugins/infra/plugins/spawn/plugins/daemon/server/internal/supervise.ts",
    },
    // Look-alikes.
    { code: `new SharedWorker(url);`, filename: SERVER },
    { code: `new pool.Worker(url);`, filename: SERVER },
    { code: `Worker(url);`, filename: SERVER },
  ],
  invalid: [
    {
      code: `new Worker(url);`,
      filename: SERVER,
      errors: [{ messageId: "rawWorker" }],
    },
    {
      code: `new Worker(new URL("./w.ts", import.meta.url), { argv });`,
      filename: "/repo/plugins/foo/central/internal/w.ts",
      errors: [{ messageId: "rawWorker" }],
    },
    {
      code: `new globalThis.Worker(url);`,
      filename: "/repo/plugins/foo/shared/w.ts",
      errors: [{ messageId: "rawWorker" }],
    },
    {
      code: `new globalThis["Worker"](url);`,
      filename: SERVER,
      errors: [{ messageId: "rawWorker" }],
    },
  ],
});
