/**
 * `agent-origin-safety/no-unmarked-app-fetch`: a Node-side fetch of the app is
 * `unmarked` (→ agentFetch), an in-page one is `inPage` (→ pageFetch: the page
 * request guard refuses it), anything else passes.
 */

import rule from "./no-unmarked-app-fetch";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const E2E = "/repo/plugins/x/e2e/flow.ts";

ruleTester.run("no-unmarked-app-fetch", rule, {
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
});
