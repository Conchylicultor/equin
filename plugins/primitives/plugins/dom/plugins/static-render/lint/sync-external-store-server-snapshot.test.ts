/**
 * Tests for the `sync-external-store-server-snapshot` lint rule: every
 * `useSyncExternalStore` call passes its third argument (getServerSnapshot),
 * because a two-argument call throws in a static render.
 */

import rule from "./sync-external-store-server-snapshot";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("sync-external-store-server-snapshot", rule, {
  valid: [
    { code: `useSyncExternalStore(subscribe, read, read);` },
    { code: `React.useSyncExternalStore(subscribe, read, () => null);` },
    {
      code: `useSyncExternalStore(s.subscribe, () => s.get(id), () => s.get(id));`,
    },
    // Another function of the same arity — out of scope.
    { code: `useSyncStore(subscribe, read);` },
    { code: `store.subscribe(listener);` },
    // A spread after the third argument hides nothing.
    { code: `useSyncExternalStore(subscribe, read, read, ...rest);` },
    // A same-named import from elsewhere is not React's hook.
    {
      code: `import { useSyncExternalStore as useStore } from "other"; useStore(a, b);`,
    },
  ],
  invalid: [
    {
      code: `useSyncExternalStore(subscribe, read);`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
    {
      code: `React.useSyncExternalStore(subscribe, read);`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
    {
      code: `function useX() { return useSyncExternalStore(s.subscribe, () => s.get()); }`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
    // A spread hides the arity: flagged.
    {
      code: `useSyncExternalStore(...args);`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
    {
      code: `useSyncExternalStore(subscribe, ...rest);`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
    // An absent value written out is still no server snapshot.
    {
      code: `useSyncExternalStore(subscribe, read, undefined);`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
    {
      code: `useSyncExternalStore(subscribe, read, void 0);`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
    // An alias of React's hook.
    {
      code: `import { useSyncExternalStore as useStore } from "react"; useStore(subscribe, read);`,
      errors: [{ messageId: "missingServerSnapshot" }],
    },
  ],
});
