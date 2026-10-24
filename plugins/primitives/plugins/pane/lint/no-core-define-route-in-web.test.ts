/**
 * Tests for the `no-core-define-route-in-web` lint rule. Run with
 * `./equin test plugins/primitives/plugins/pane`.
 *
 * The rule pins ONE import path for `defineRoute` per runtime: a `web/` file
 * takes it from the pane WEB barrel (which re-exports it), everything else from
 * the pane CORE barrel. Every case sets `filename` explicitly — the runtime
 * folder IS the rule's input, so a case without one would test nothing.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-core-define-route-in-web";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

const WEB_FILE = "/repo/plugins/debug/plugins/queue/web/panes.ts";
const CORE_FILE = "/repo/plugins/build/core/routes.ts";
const SHARED_FILE = "/repo/plugins/build/shared/routes.ts";
const SERVER_FILE = "/repo/plugins/build/server/links.ts";
const OWNER_WEB_FILE =
  "/repo/plugins/primitives/plugins/pane/web/__tests__/app-index.test.tsx";

// `RuleTester.run` drives the test harness itself (it calls the ambient
// describe/it that bun:test provides), so it must run at module top level —
// never wrapped in a `test()` callback.
ruleTester.run(
  "no-core-define-route-in-web",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The canonical web spelling: one pane import, identity included.
      {
        filename: WEB_FILE,
        code: `import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";`,
      },
      // A core file is the core barrel's proper consumer.
      {
        filename: CORE_FILE,
        code: `import { defineRoute } from "@plugins/primitives/plugins/pane/core";`,
      },
      // So is a shared/ file, and a server one.
      {
        filename: SHARED_FILE,
        code: `import { defineRoute } from "@plugins/primitives/plugins/pane/core";`,
      },
      {
        filename: SERVER_FILE,
        code: `import { defineRoute } from "@plugins/primitives/plugins/pane/core";`,
      },
      // Other core-barrel symbols are NOT re-exported from web, so a web file
      // reaching for them has no second spelling to choose between.
      {
        filename: WEB_FILE,
        code: `import { normalizeRoutePath } from "@plugins/primitives/plugins/pane/core";`,
      },
      {
        filename: WEB_FILE,
        code: `import type { AppRef, RouteDef } from "@plugins/primitives/plugins/pane/core";`,
      },
      // A type-only specifier for the factory carries no value edge.
      {
        filename: WEB_FILE,
        code: `import { type defineRoute } from "@plugins/primitives/plugins/pane/core";`,
      },
      // The owner's own tree: its jsdom suites drive the core barrel on purpose.
      {
        filename: OWNER_WEB_FILE,
        code: `import { defineApp, defineRoute } from "@plugins/primitives/plugins/pane/core";`,
      },
      // A same-named factory from an unrelated module is not this symbol.
      {
        filename: WEB_FILE,
        code: `import { defineRoute } from "some-router";`,
      },
      // A `web` directory NESTED under another runtime folder is not the web
      // runtime — segment arithmetic, not a substring match.
      {
        filename: "/repo/plugins/build/core/web/routes.ts",
        code: `import { defineRoute } from "@plugins/primitives/plugins/pane/core";`,
      },
      // A namespace import of the core barrel used for something else.
      {
        filename: WEB_FILE,
        code: `
          import * as paneCore from "@plugins/primitives/plugins/pane/core";
          const p = paneCore.normalizeRoutePath(raw);
        `,
      },
    ],
    invalid: [
      // The shape this rule exists to remove: two pane imports in one web file.
      {
        filename: WEB_FILE,
        code: `
          import { Pane } from "@plugins/primitives/plugins/pane/web";
          import { defineRoute } from "@plugins/primitives/plugins/pane/core";
        `,
        errors: [{ messageId: "wrongBarrel" }],
      },
      // A .tsx web file, aliased import — the IMPORTED name is what is keyed on.
      {
        filename:
          "/repo/plugins/apps/plugins/studio/plugins/explorer/web/panes.tsx",
        code: `import { defineRoute as route } from "@plugins/primitives/plugins/pane/core";`,
        errors: [{ messageId: "wrongBarrel" }],
      },
      // Mixed specifiers: only the factory is reported.
      {
        filename: WEB_FILE,
        code: `import { normalizeRoutePath, defineRoute } from "@plugins/primitives/plugins/pane/core";`,
        errors: [{ messageId: "wrongBarrel" }],
      },
      // A deeply nested plugin's web folder is still the web runtime.
      {
        filename:
          "/repo/plugins/apps/plugins/agent-manager/plugins/welcome/web/panes.tsx",
        code: `import { defineRoute } from "@plugins/primitives/plugins/pane/core";`,
        errors: [{ messageId: "wrongBarrel" }],
      },
      // Namespace import, member access to the factory.
      {
        filename: WEB_FILE,
        code: `
          import * as paneCore from "@plugins/primitives/plugins/pane/core";
          const r = paneCore.defineRoute({ id: "x", segment: "x" });
        `,
        errors: [{ messageId: "wrongBarrel" }],
      },
    ],
  },
);
