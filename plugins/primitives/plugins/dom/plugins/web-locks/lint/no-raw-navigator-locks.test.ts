import rule from "./no-raw-navigator-locks";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/web/components/x.ts";

ruleTester.run("no-raw-navigator-locks", rule, {
  valid: [
    {
      code: `const l = webLocks(); if (l.kind === "supported") void l.locks.request("a", () => undefined);`,
      filename: FILE,
    },
    { code: `const x = deps.locks.request("a", f);`, filename: FILE },
    { code: `const x = navigator.serviceWorker;`, filename: FILE },
    { code: `function f(l: LockManager) { return l; }`, filename: FILE },
  ],
  invalid: [
    {
      code: `void navigator.locks.request("a", f);`,
      filename: FILE,
      errors: [{ messageId: "noRawNavigatorLocks" }],
    },
    {
      code: `const l = (navigator as Navigator & { locks?: LockManager }).locks;`,
      filename: FILE,
      errors: [{ messageId: "noRawNavigatorLocks" }],
    },
    {
      code: `const l = globalThis.navigator.locks;`,
      filename: FILE,
      errors: [{ messageId: "noRawNavigatorLocks" }],
    },
    {
      code: `if ("locks" in navigator) f();`,
      filename: FILE,
      errors: [{ messageId: "noRawNavigatorLocks" }],
    },
  ],
});
