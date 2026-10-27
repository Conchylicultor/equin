/**
 * Tests for `networking/no-request-guard-capability`: importing one of the
 * request guard's natives is flagged (sanctioned holders are exempted in their
 * own `exempt/index.ts`, outside the rule); its public names are not.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-request-guard-capability";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const FILE = "/repo/plugins/x/web/components/x.tsx";
const GUARD =
  "@plugins/primitives/plugins/networking/plugins/request-guard/web";

ruleTester.run(
  "no-request-guard-capability",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        filename: FILE,
        code: `import { RawApiRequestError, requestGuardReportSink } from "${GUARD}";`,
      },
      {
        filename: FILE,
        code: `import type { GuardedChannel } from "${GUARD}";`,
      },
      {
        filename: FILE,
        code: `import { useTransport } from "@plugins/primitives/plugins/networking/web";`,
      },
    ],
    invalid: [
      {
        filename: FILE,
        code: `import { nativeFetch } from "${GUARD}";`,
        errors: [{ messageId: "capability" }],
      },
      {
        filename: FILE,
        code: `import { RawApiRequestError, nativeWebSocket as ws } from "${GUARD}";`,
        errors: [{ messageId: "capability" }],
      },
      {
        filename: FILE,
        code: `import { allowAssetRoute, installRequestGuard } from "${GUARD}";`,
        errors: [{ messageId: "capability" }, { messageId: "capability" }],
      },
      {
        filename: FILE,
        code: `import * as guard from "${GUARD}";`,
        errors: [{ messageId: "capability" }],
      },
      {
        filename: FILE,
        code: `export { nativeFetch } from "${GUARD}";`,
        errors: [{ messageId: "capability" }],
      },
      {
        filename: FILE,
        code: `export * from "${GUARD}";`,
        errors: [{ messageId: "capability" }],
      },
      {
        filename: FILE,
        code: `const m = await import("${GUARD}");`,
        errors: [{ messageId: "capability" }],
      },
    ],
  },
);
