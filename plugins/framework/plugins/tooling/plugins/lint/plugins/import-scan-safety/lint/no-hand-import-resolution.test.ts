import rule from "./no-hand-import-resolution";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/check/index.ts";
const bad = (code: string) => ({
  code,
  filename: FILE,
  errors: [{ messageId: "handResolution" as const }],
});
const relative = (code: string) => ({
  code,
  filename: FILE,
  errors: [{ messageId: "relativeResolution" as const }],
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
    // A directory joined with a literal, or with a name that is no specifier.
    { code: `const p = join(dirname(file), "x.json");`, filename: FILE },
    { code: `const p = join(dirname(file), entry.name);`, filename: FILE },
    { code: `const p = \`\${dir}/\${name}\`;`, filename: FILE },
    { code: `const p = \`\${root}/\${spec}\`;`, filename: FILE },
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
    relative(`const p = join(dirname(importer), specifier);`),
    relative(`const p = posix.join(posix.dirname(fromFile), spec);`),
    relative(`const p = relJoin(relDirname(fromRel), imp.specifier);`),
    relative(`const p = \`\${dir}/\${specifier}\`;`),
    relative(`const dir = dirname(f); const p = join(dir, spec);`),
    relative(`const p = resolve(dirname(importer), specifier);`),
    relative(`const p = \`\${dirname(f)}/\${spec}\`;`),
  ],
});
