import rule, { TIMED_FS_MODULE as T } from "./no-untimed-fs-read";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const SERVER = "/repo/plugins/foo/server/internal/read.ts";

ruleTester.run("no-untimed-fs-read", rule, {
  valid: [
    {
      code: `import { writeFileSync, mkdirSync } from "node:fs";`,
      filename: SERVER,
    },
    { code: `import { readFile } from "node:fs";`, filename: SERVER }, // callback form
    { code: `import type { Stats } from "node:fs";`, filename: SERVER },
    { code: `import { type Dirent } from "node:fs";`, filename: SERVER },
    {
      code: `import * as fs from "node:fs"; fs.writeFileSync("x", "");`,
      filename: SERVER,
    },
    {
      code: `import { readFileSync } from "node:fs";`,
      filename: "/repo/plugins/foo/web/a.ts",
    },
    {
      code: `import { readFileSync } from "${T}"; readFileSync("x");`,
      filename: SERVER,
    },
  ],
  invalid: [
    {
      code: `import { readFileSync, writeFileSync } from "node:fs";\nreadFileSync("x");`,
      filename: SERVER,
      errors: [{ messageId: "untimed" }],
      output: `import { writeFileSync } from "node:fs";\nimport { readFileSync } from "${T}";\nreadFileSync("x");`,
    },
    {
      code: `import { stat, readdir as rd } from "node:fs/promises";\nawait stat("x"); await rd("y");`,
      filename: SERVER,
      errors: [{ messageId: "untimed" }, { messageId: "untimed" }],
      output: `import { stat, readdir as rd } from "${T}";\nawait stat("x"); await rd("y");`,
    },
    {
      code: `import * as fs from "node:fs";\nfs.statSync("x"); fs.mkdirSync("y");`,
      filename: SERVER,
      errors: [{ messageId: "untimed" }],
      output: `import * as fs from "node:fs";\nimport { statSync } from "${T}";\nstatSync("x"); fs.mkdirSync("y");`,
    },
    {
      code: `import fs from "fs";\nawait fs.promises.readFile("x"); fs.existsSync("y");`,
      filename: SERVER,
      errors: [{ messageId: "untimed" }, { messageId: "untimed" }],
      output: `import { readFile, existsSync } from "${T}";\nawait readFile("x"); existsSync("y");`,
    },
    {
      // A local `stat` already answers to the bare name: the call is aliased.
      code: `import * as fsp from "node:fs/promises";\nconst stat = 1;\nawait fsp.stat("x"); await fsp.writeFile("y", "");`,
      filename: SERVER,
      errors: [{ messageId: "untimed" }],
      output: `import * as fsp from "node:fs/promises";\nimport { stat as timedStat } from "${T}";\nconst stat = 1;\nawait timedStat("x"); await fsp.writeFile("y", "");`,
    },
    {
      // Two fs imports and an existing timed import: one merged import.
      code: `import { statSync } from "node:fs";\nimport { readdir } from "node:fs/promises";\nimport { lstat } from "${T}";\nstatSync("a"); await readdir("b"); await lstat("c");`,
      filename: SERVER,
      errors: [{ messageId: "untimed" }, { messageId: "untimed" }],
      output: `\n\nimport { lstat, statSync, readdir } from "${T}";\nstatSync("a"); await readdir("b"); await lstat("c");`,
    },
  ],
});
