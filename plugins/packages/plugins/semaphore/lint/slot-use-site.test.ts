/**
 * Tests for `semaphore/slot-use-site`: importing `usingSlot` is the one way to
 * hold a use-scoped slot, so every import is reported — the primitives that may
 * are sanctioned exemptions in their own `exempt/index.ts`.
 */
import rule from "./slot-use-site";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("slot-use-site", rule, {
  valid: [
    {
      code: `import { createSemaphore } from "@plugins/packages/plugins/semaphore/core";`,
    },
    { code: `import { usingSlot } from "./somewhere-else";` },
  ],
  invalid: [
    {
      code: `import { usingSlot } from "@plugins/packages/plugins/semaphore/core";`,
      errors: [{ messageId: "slotUseSite" }],
    },
    {
      code: `import { createSemaphore, usingSlot as hold } from "@plugins/packages/plugins/semaphore/core";`,
      errors: [{ messageId: "slotUseSite" }],
    },
    {
      code: `import { usingSlot } from "./lease-scope";`,
      errors: [{ messageId: "slotUseSite" }],
    },
    {
      code: `import * as semaphore from "@plugins/packages/plugins/semaphore/core";`,
      errors: [{ messageId: "slotUseSite" }],
    },
  ],
});
