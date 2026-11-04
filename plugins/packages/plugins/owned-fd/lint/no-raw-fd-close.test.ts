import rule from "./no-raw-fd-close";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const SERVER = "/repo/plugins/foo/server/internal/fds.ts";

ruleTester.run("no-raw-fd-close", rule, {
  valid: [
    {
      code: `import { openSync, writeSync } from "node:fs";`,
      filename: SERVER,
    },
    { code: `import type { closeSync } from "node:fs";`, filename: SERVER },
    {
      code: `import * as fs from "node:fs"; fs.writeFileSync("x", "");`,
      filename: SERVER,
    },
    {
      code: `import { open } from "node:fs/promises"; const h = await open("x"); await h.close();`,
      filename: SERVER,
    },
    { code: `socket.close(); server.close();`, filename: SERVER },
  ],
  invalid: [
    {
      code: `import { openSync, closeSync } from "node:fs";\ncloseSync(openSync("x"));`,
      filename: SERVER,
      errors: [{ messageId: "rawClose", data: { name: "closeSync" } }],
    },
    {
      code: `import { close as c } from "fs";`,
      filename: SERVER,
      errors: [{ messageId: "rawClose" }],
    },
    {
      code: `import * as fs from "node:fs";\nfs.closeSync(3); fs.close(4, () => {});`,
      filename: SERVER,
      errors: [{ messageId: "rawClose" }, { messageId: "rawClose" }],
    },
    {
      code: `import * as fs from "node:fs";\nconst { closeSync, writeSync } = fs;`,
      filename: SERVER,
      errors: [{ messageId: "rawClose" }],
    },
    {
      code: `import fs from "fs";\nfs["closeSync"](3);`,
      filename: SERVER,
      errors: [{ messageId: "rawClose" }],
    },
  ],
});
