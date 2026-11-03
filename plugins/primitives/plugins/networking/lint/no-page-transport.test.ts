/**
 * Tests for the `networking/no-page-transport` lint rule: every import of the
 * page-transport barrel is flagged (sanctioned importers are exempted in their
 * own `exempt/index.ts`, outside the rule).
 */

import rule from "./no-page-transport";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const FILE = "/repo/plugins/x/web/components/x.tsx";
const PAGE =
  "@plugins/primitives/plugins/networking/plugins/page-transport/web";

ruleTester.run("no-page-transport", rule, {
  valid: [
    {
      filename: FILE,
      code: `import { useNotificationsClient } from "@plugins/network/plugins/live/plugins/live-state/web";`,
    },
    {
      filename: FILE,
      code: `import { useTransport } from "@plugins/primitives/plugins/networking/web";`,
    },
  ],
  invalid: [
    {
      filename: FILE,
      code: `import { getNotificationsClient } from "@plugins/network/plugins/live/plugins/live-state/web";`,
      errors: [{ messageId: "noPageTransport" }],
    },
    {
      filename: FILE,
      code: `import { pageTransport } from "${PAGE}";`,
      errors: [{ messageId: "noPageTransport" }],
    },
    {
      filename: FILE,
      code: `export { pageTransport } from "${PAGE}";`,
      errors: [{ messageId: "noPageTransport" }],
    },
    {
      filename: FILE,
      code: `const m = await import("${PAGE}");`,
      errors: [{ messageId: "noPageTransport" }],
    },
  ],
});
