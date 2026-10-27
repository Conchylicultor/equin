import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-direct-store";

// Hand RuleTester bun's own describe/it, or it registers nothing under
// `./equin test`.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const BARREL = "@plugins/infra/plugins/paths/plugins/data-files/server";

ruleTester.run(
  "no-direct-store",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
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
  },
);
