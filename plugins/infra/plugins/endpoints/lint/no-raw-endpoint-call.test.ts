/**
 * Tests for `no-raw-endpoint-call`: a hand-written `/api/…` path or a fetch to
 * an endpoint's `.path` is reported off the page, while web, e2e and test
 * code — and look-alikes — are left alone.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-raw-endpoint-call";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const SERVER = "/repo/plugins/foo/server/internal/client.ts";

ruleTester.run(
  "no-raw-endpoint-call",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        code: `await callEndpoint(secretsSet, {}, { origin, body });`,
        filename: SERVER,
      },
      // Out of scope: the page, e2e scripts, tests.
      { code: `fetch("/api/x/y");`, filename: "/repo/plugins/foo/web/a.ts" },
      { code: `fetch("/api/x/y");`, filename: "/repo/plugins/foo/e2e/a.ts" },
      {
        code: `fetch("/api/x/y");`,
        filename: "/repo/plugins/foo/server/a.test.ts",
      },
      // Look-alikes: a prefix test, a third-party URL, a returned path.
      { code: `p.startsWith("/api/");`, filename: SERVER },
      { code: `fetch("https://example.com/api/v1/users");`, filename: SERVER },
      {
        code: "const f = (id) => `/api/attachments/$" + "{id}`;",
        filename: SERVER,
      },
      { code: `fetch(join(root, file));`, filename: SERVER },
    ],
    invalid: [
      {
        code: `post("/api/secrets/set", body);`,
        filename: SERVER,
        errors: [{ messageId: "routePath" }],
      },
      {
        code: `fetch(namespaceUrl(ns, "/api/health"));`,
        filename: "/repo/plugins/foo/cli/run.ts",
        errors: [{ messageId: "routePath" }],
      },
      {
        code: "fetch(`http://localhost:9000/api/auth/token`);",
        filename: "/repo/plugins/foo/machine/a.ts",
        errors: [{ messageId: "routePath" }],
      },
      {
        code: "fetch(`$" + "{origin}$" + "{revertAgentWrites.path}`, init);",
        filename: "/repo/plugins/foo/shared/revert.ts",
        errors: [{ messageId: "endpointFetch" }],
      },
      {
        code: `const url = namespaceUrl(ns, extractPath(run.route));\nawait fetch(url, init);`,
        filename: SERVER,
        errors: [{ messageId: "endpointFetch" }],
      },
    ],
  },
);
