/**
 * Tests for `no-direct-custom-toast`: naming `useShowCustomToast` from the
 * toast barrel is reported; the barrel's other names, and other modules, are not.
 */

import rule from "./no-direct-custom-toast";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const FILE = "/repo/plugins/foo/web/components/x.tsx";
const TOAST = "@plugins/shell/plugins/toast/web";
const error = { messageId: "direct" as const };

ruleTester.run("no-direct-custom-toast", rule, {
  valid: [
    { code: `import { isInToast } from "${TOAST}";`, filename: FILE },
    { code: `import { useSuppressToasts } from "${TOAST}";`, filename: FILE },
    {
      code: `import { useShowCustomToast } from "@plugins/other/web";`,
      filename: FILE,
    },
    {
      code: `import { useToast } from "@plugins/shell/plugins/notifications/web";`,
      filename: FILE,
    },
  ],
  invalid: [
    {
      code: `import { useShowCustomToast } from "${TOAST}";`,
      filename: FILE,
      errors: [error],
    },
    {
      code: `import { isInToast, useShowCustomToast as show } from "${TOAST}";`,
      filename: FILE,
      errors: [error],
    },
    {
      code: `import type { useShowCustomToast } from "${TOAST}";`,
      filename: FILE,
      errors: [error],
    },
    {
      code: `export { useShowCustomToast } from "${TOAST}";`,
      filename: FILE,
      errors: [error],
    },
  ],
});
