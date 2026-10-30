/**
 * Tests for `no-blocking-check-work`: blocking fs/process calls and direct
 * whole-file parses are reported in a `check/` folder's code, and left alone
 * everywhere else.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-blocking-check-work";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const CHECK = "/repo/plugins/foo/check/index.ts";

ruleTester.run(
  "no-blocking-check-work",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Outside a check/ folder.
      {
        code: `import { readFileSync } from "node:fs"; readFileSync("x");`,
        filename: "/repo/plugins/foo/server/a.ts",
      },
      {
        code: `maskSource(src); ts.createSourceFile(f, s, t, true);`,
        filename: "/repo/plugins/foo/core/a.ts",
      },
      // A plugin NAMED check is not a check/ folder.
      {
        code: `for (const f of fs) readFileSync(f);`,
        filename:
          "/repo/plugins/framework/plugins/cli/plugins/check/cli/run.ts",
      },
      // The async forms.
      {
        code: `await readFile("x"); await repo.read("x"); await maskedSource(s); await parsedTsSource(ts, s);`,
        filename: CHECK,
      },
      // A blocking call made once (not per item) costs one syscall.
      {
        code: `const text = readFileSync(join(root, "a.json"), "utf8"); if (!existsSync(f)) return;`,
        filename: CHECK,
      },
      // A loop's iterable runs once.
      {
        code: `for (const f of readdirSync(dir)) count++;`,
        filename: CHECK,
      },
      {
        code: `function helper(p) { return readFileSync(p); }`,
        filename: CHECK,
      },
      // A name that only looks alike.
      { code: `readFileSyncish("x"); obj.readFile("x");`, filename: CHECK },
    ],
    invalid: [
      {
        code: `import { readFileSync } from "node:fs"; for (const f of fs) readFileSync(f);`,
        filename: CHECK,
        errors: [{ messageId: "blockingCall" }],
      },
      {
        code: `files.filter((p) => fs.existsSync(p)); while (x) Bun.spawnSync(["git"]); for (const d of ds) { const r = () => 1; glob.scanSync(d); }`,
        filename: "/repo/plugins/a/plugins/b/check/helper.ts",
        errors: [
          { messageId: "blockingCall" },
          { messageId: "blockingCall" },
          { messageId: "blockingCall" },
        ],
      },
      {
        code: `files.map((f) => maskSource(f.src)); ts.createSourceFile(f, s, t, true);`,
        filename: CHECK,
        errors: [{ messageId: "syncParse" }, { messageId: "syncParse" }],
      },
    ],
  },
);
