import rule from "./no-direct-store";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const BARREL = "@plugins/infra/plugins/paths/plugins/data-files/server";

ruleTester.run("no-direct-store", rule, {
  valid: [
    // Holding a declared root is the sanctioned use.
    {
      code: `import { defineFileRoot } from "${BARREL}"; const r = defineFileRoot({ id: "a", dir: "apps/a" }); await r.list(p);`,
    },
    // Providing the service is not reading it.
    {
      code: `import { DataFiles } from "${BARREL}"; export default { contributions: [DataFiles.provide(impl)] };`,
    },
    // Another service's get().
    {
      code: `import { DataFiles } from "./elsewhere"; DataFiles.get();`,
    },
    { code: `const m = new Map(); m.get("k");` },
  ],
  invalid: [
    {
      code: `import { DataFiles } from "${BARREL}"; DataFiles.get().root(spec);`,
      errors: [{ messageId: "directStore" }],
    },
    {
      code: `import { DataFiles as Files } from "${BARREL}"; const s = Files.get();`,
      errors: [{ messageId: "directStore" }],
    },
    {
      code: `import * as df from "${BARREL}"; df.DataFiles.get();`,
      errors: [{ messageId: "directStore" }],
    },
  ],
});
