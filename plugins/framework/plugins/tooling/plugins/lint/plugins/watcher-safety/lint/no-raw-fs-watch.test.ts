/**
 * Tests for `no-raw-fs-watch`: node:fs watch APIs (named, namespace, default,
 * `fs.promises`, `fs/promises`) and chokidar are reported in host-process code,
 * while web code, tests, type-only imports and look-alikes are left alone.
 */

import rule from "./no-raw-fs-watch";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const SERVER = "/repo/plugins/foo/server/internal/watch.ts";
const CLI = "/repo/plugins/foo/cli/run.ts";

ruleTester.run("no-raw-fs-watch", rule, {
  valid: [
    // Browser code is out of scope.
    {
      code: `import { watch } from "node:fs";`,
      filename: "/repo/plugins/foo/web/a.ts",
    },
    // Tests are out of scope.
    {
      code: `import { watch } from "node:fs";`,
      filename: "/repo/plugins/foo/server/a.test.ts",
    },
    // Other fs APIs.
    {
      code: `import { readFileSync, statSync } from "node:fs"; readFileSync("x");`,
      filename: SERVER,
    },
    {
      code: `import * as fs from "node:fs"; fs.readFileSync("x"); fs.promises.readFile("x");`,
      filename: SERVER,
    },
    // A `watch` that is not fs's.
    { code: `const w = { watch() {} }; w.watch();`, filename: SERVER },
    { code: `import { watch } from "vue";`, filename: SERVER },
    // Type-only imports load nothing.
    { code: `import type { FSWatcher } from "node:fs";`, filename: SERVER },
  ],
  invalid: [
    {
      code: `import { watch } from "node:fs";`,
      filename: SERVER,
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `import { watchFile, unwatchFile } from "fs";`,
      filename: CLI,
      errors: [{ messageId: "rawFsWatch" }, { messageId: "rawFsWatch" }],
    },
    {
      code: `import { watch as w } from "node:fs/promises";`,
      filename: "/repo/plugins/foo/shared/a.ts",
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `import * as fs from "node:fs"; fs.watch("x", () => {});`,
      filename: "/repo/plugins/foo/central/a.ts",
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `import fs from "fs"; fs.watchFile("x", () => {});`,
      filename: SERVER,
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `import fs from "node:fs"; fs.promises.watch("x");`,
      filename: SERVER,
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `import { promises } from "node:fs"; promises.watch("x");`,
      filename: SERVER,
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `import * as fsp from "fs/promises"; fsp.watch("x");`,
      filename: "/repo/plugins/foo/bin/index.ts",
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `import chokidar from "chokidar";`,
      filename: SERVER,
      errors: [{ messageId: "rawFsWatch" }],
    },
    {
      code: `const c = await import("chokidar");`,
      filename: SERVER,
      errors: [{ messageId: "rawFsWatch" }],
    },
  ],
});
