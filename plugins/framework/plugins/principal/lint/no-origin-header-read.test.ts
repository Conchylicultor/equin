/**
 * Tests for `no-origin-header-read`: a handler reading the Origin /
 * Sec-Fetch-* request headers is reported; other headers and look-alikes are
 * left alone.
 */

import rule from "./no-origin-header-read";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const FILE = "/repo/plugins/foo/machine/internal/routes.ts";

ruleTester.run("no-origin-header-read", rule, {
  valid: [
    { code: `req.headers.get("content-type");`, filename: FILE },
    { code: `res.headers.get("ETag");`, filename: FILE },
    { code: `url.searchParams.get("origin");`, filename: FILE },
    { code: `map.get("origin");`, filename: FILE },
    { code: `req.headers.get(name);`, filename: FILE },
    { code: `req.headers.get("x-equin-principal");`, filename: FILE },
  ],
  invalid: [
    {
      code: `req.headers.get("origin");`,
      filename: FILE,
      errors: [{ messageId: "originRead" }],
    },
    {
      code: `req.headers.get("Origin");`,
      filename: FILE,
      errors: [{ messageId: "originRead" }],
    },
    {
      code: `req.headers.has("sec-fetch-site");`,
      filename: FILE,
      errors: [{ messageId: "originRead" }],
    },
    {
      code: "request.headers.get(`Sec-Fetch-Mode`);",
      filename: FILE,
      errors: [{ messageId: "originRead" }],
    },
    {
      code: `headers.get("sec-fetch-dest");`,
      filename: FILE,
      errors: [{ messageId: "originRead" }],
    },
  ],
});
