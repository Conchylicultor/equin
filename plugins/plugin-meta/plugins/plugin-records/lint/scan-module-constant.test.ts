import rule from "./scan-module-constant";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const SCAN = "src/words.scan.ts";

ruleTester.run("scan-module-constant", rule, {
  valid: [
    {
      filename: SCAN,
      code: `export const WORDS: FileScan<string[]> = { url: import.meta.url, scan: (s) => s.split(" ") };`,
    },
    {
      filename: SCAN,
      code: `export const WORDS = { url: import.meta.url, scan: (s: string) => [s] } satisfies FileScan<string[]>;`,
    },
    // Outside a scan module the rule says nothing.
    {
      filename: "src/rule.ts",
      code: `export function make() { return { url: import.meta.url }; }`,
    },
  ],
  invalid: [
    {
      filename: SCAN,
      code: `export function wordsScan(ts: unknown): FileScan<string[]> { return { url: import.meta.url, scan: (s) => [String(ts), s] }; }`,
      errors: [{ messageId: "notConstant" }],
    },
    {
      filename: SCAN,
      code: `const WORDS = { url: import.meta.url, scan: (s: string) => [s] };\nexport { WORDS };`,
      errors: [{ messageId: "notConstant" }],
    },
    {
      filename: SCAN,
      code: `const here = import.meta.url;\nexport const WORDS = { url: here, scan: (s: string) => [s] };`,
      errors: [{ messageId: "notConstant" }],
    },
  ],
});
