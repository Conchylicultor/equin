import rule from "./no-hand-import-resolution";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/check/index.ts";
const bad = (code: string) => ({
  code,
  filename: FILE,
  errors: [{ messageId: "handResolution" as const }],
});

ruleTester.run("no-hand-import-resolution", rule, {
  valid: [
    // A specifier read for its own text: a plugin path, a barrel folder.
    {
      code: `const id = spec.slice("@plugins/".length).split("/");`,
      filename: FILE,
    },
    {
      code: `const rel = spec.slice("@plugins/".length); const kind = rel.slice(rel.lastIndexOf("/") + 1);`,
      filename: FILE,
    },
    { code: `const name = spec.replace(/^@plugins\\//, "");`, filename: FILE },
    // Another prefix's length.
    {
      code: `const p = \`plugins/\${spec.slice("@other/".length)}\`;`,
      filename: FILE,
    },
    // A const that is not the alias.
    {
      code: `const A = "@x/"; const p = \`plugins/\${spec.slice(A.length)}\`;`,
      filename: FILE,
    },
  ],
  invalid: [
    bad(`const p = \`plugins/\${spec.slice("@plugins/".length)}\`;`),
    bad(`const p = "plugins/" + spec.slice("@plugins/".length);`),
    bad(
      `const ALIAS = "@plugins/"; const p = \`plugins/\${spec.slice(ALIAS.length)}\`;`,
    ),
    bad(
      `const rel = spec.slice("@plugins/".length); const p = join(root, "plugins", rel);`,
    ),
    bad(`const rel = spec.slice(9); const p = \`\${root}/plugins/\${rel}\`;`),
    bad(`const p = spec.replace("@plugins/", "plugins/");`),
    bad(`const p = spec.replace(/^@plugins\\//, "plugins/");`),
  ],
});
