/**
 * `agent-origin-safety/no-unmarked-app-fetch`: a Node-side fetch of the app is
 * `unmarked` (→ agentFetch), an in-page one is `inPage` (→ pageFetch: the page
 * request guard refuses it), anything else passes.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-unmarked-app-fetch";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const E2E = "/repo/plugins/x/e2e/flow.ts";

ruleTester.run(
  "no-unmarked-app-fetch",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      { filename: E2E, code: `await fetch("https://example.com/x");` },
      { filename: E2E, code: `await fetch(url);` },
      { filename: E2E, code: `await fetch("/artifacts/x.js");` },
      {
        filename: "/repo/plugins/x/server/handler.ts",
        code: `await fetch(pathUrl("/api/x"));`,
      },
    ],
    invalid: [
      {
        filename: E2E,
        code: `await fetch(pathUrl("/api/x"));`,
        errors: [{ messageId: "unmarked" }],
      },
      {
        filename: E2E,
        code: `await fetch(\`\${base}/api/x\`);`,
        errors: [{ messageId: "unmarked" }],
      },
      {
        filename: E2E,
        code: `await page.evaluate(() => fetch("/api/blocks", { method: "POST" }));`,
        errors: [{ messageId: "inPage" }],
      },
      {
        filename: E2E,
        code: `await page.evaluate((id) => fetch(\`/api/pages/\${id}/blocks\`), id);`,
        errors: [{ messageId: "inPage" }],
      },
      {
        filename: E2E,
        code: `await page.evaluate(() => fetch("/gateway/status"));`,
        errors: [{ messageId: "inPage" }],
      },
    ],
  },
);
