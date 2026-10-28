/**
 * Tests for the `endpoints/no-endpoint-effect-internals` lint rule: the
 * predicted-endpoint plumbing is imported only by its one client
 * (network/live, under its own exemption).
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-endpoint-effect-internals";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const FILE = "/repo/plugins/x/web/components/x.tsx";
const c = (code: string) => ({ filename: FILE, code });
const BARREL = `"@plugins/infra/plugins/endpoints/core"`;

ruleTester.run(
  "no-endpoint-effect-internals",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      c(`import { defineEndpoint, type EndpointEffect } from ${BARREL};`),
      c(
        `import * as e from ${BARREL}; e.defineEndpoint({ route: "POST /x" });`,
      ),
      // Another module's same-named export is not the endpoints one.
      c(`import { endpointContractOf } from "./local";`),
    ],
    invalid: [
      {
        ...c(`import { endpointContractOf } from ${BARREL};`),
        errors: [{ messageId: "internal" }],
      },
      {
        ...c(`import { brandEndpointEffect as mint } from ${BARREL};`),
        errors: [{ messageId: "internal" }],
      },
      {
        ...c(`export { endpointEffectPayload } from ${BARREL};`),
        errors: [{ messageId: "internal" }],
      },
      {
        ...c(`import * as e from ${BARREL}; e.endpointContractOf(def);`),
        errors: [{ messageId: "internal" }],
      },
    ],
  },
);
