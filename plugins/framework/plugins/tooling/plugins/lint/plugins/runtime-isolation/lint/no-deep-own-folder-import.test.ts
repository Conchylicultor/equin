/**
 * Tests for the `no-deep-own-folder-import` lint rule.
 *
 * A browser-built file (web/, core/, shared/, exhibits/) reaches a sibling
 * folder of its own plugin only through that folder's barrel. The file under
 * lint is given by the RuleTester `filename` option.
 */

import rule from "./no-deep-own-folder-import";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const PLUGIN = "/repo/plugins/ui/plugins/theme-engine";
const WEB_FILE = `${PLUGIN}/web/components/theme-injector.tsx`;
const SHARED_FILE = `${PLUGIN}/shared/resources.ts`;
const SERVER_FILE = `${PLUGIN}/server/internal/handler.ts`;
const EXHIBIT_FILE = `${PLUGIN}/exhibits/internal/composer.tsx`;

ruleTester.run("no-deep-own-folder-import", rule, {
  valid: [
    // Every spelling of the barrel.
    { code: `import { a } from "../../core";`, filename: WEB_FILE },
    { code: `import { a } from "../../core/index";`, filename: WEB_FILE },
    { code: `import { a } from "../../core/index.ts";`, filename: WEB_FILE },
    {
      code: `import { a } from "@plugins/ui/plugins/theme-engine/core";`,
      filename: WEB_FILE,
    },
    // Inside the importer's own folder.
    { code: `import { a } from "../internal/x";`, filename: WEB_FILE },
    // shared/ is inlined into every artifact — deep is fine.
    { code: `import { a } from "../../shared/x";`, filename: WEB_FILE },
    // A sub-plugin is another plugin.
    {
      code: `import { a } from "../../plugins/child/core/x";`,
      filename: WEB_FILE,
    },
    // Another plugin entirely (the boundary check's business).
    {
      code: `import { a } from "@plugins/ui/plugins/tweakcn/core/x";`,
      filename: WEB_FILE,
    },
    // CSS and query imports stay in-graph in the builder.
    { code: `import "../../core/theme.css";`, filename: WEB_FILE },
    { code: `import raw from "../../core/x.svg?raw";`, filename: WEB_FILE },
    // A server file runs under Bun, which loads the deep file itself.
    {
      code: `import { a } from "../../core/internal/x";`,
      filename: SERVER_FILE,
    },
    // npm packages.
    { code: `import { z } from "zod";`, filename: WEB_FILE },
    // exhibits/ is co-built INTO the web artifact, so its own web/ is inlined
    // beside it: a deep import means the file, in the browser and to tsc.
    {
      code: `import { Composer } from "../../web/components/composer";`,
      filename: EXHIBIT_FILE,
    },
    {
      code: `import { Composer } from "@plugins/ui/plugins/theme-engine/web/components/composer";`,
      filename: EXHIBIT_FILE,
    },
  ],
  invalid: [
    // The outage: a deep relative import from web/ into its own core/.
    {
      code: `import { mergeGroupValues } from "../../core/merge-group-values";`,
      filename: WEB_FILE,
      errors: [{ messageId: "deepImport" }],
      output: `import { mergeGroupValues } from "../../core";`,
    },
    // Type-only imports too.
    {
      code: `import type { T } from "../../core/types";`,
      filename: WEB_FILE,
      errors: [{ messageId: "deepImport" }],
      output: `import type { T } from "../../core";`,
    },
    // The plugin's own self-specifier, deep.
    {
      code: `import { a } from '@plugins/ui/plugins/theme-engine/core/internal/x';`,
      filename: WEB_FILE,
      errors: [{ messageId: "deepImport" }],
      output: `import { a } from '@plugins/ui/plugins/theme-engine/core';`,
    },
    // shared/ is inlined into browser artifacts, so it is held to the rule.
    {
      code: `export { S } from "../core/protocol";`,
      filename: SHARED_FILE,
      errors: [{ messageId: "deepImport" }],
      output: `export { S } from "../core";`,
    },
    // core/ reaching into web/ is routed to the web barrel the same way.
    {
      code: `const m = import("../web/components/x");`,
      filename: `${PLUGIN}/core/lazy.ts`,
      errors: [{ messageId: "deepImport" }],
      output: `const m = import("../web");`,
    },
    // The exemption is exhibits → web ONLY: exhibits/ into its own core/ is
    // routed to the core barrel like any other folder.
    {
      code: `import { a } from "../../core/internal/x";`,
      filename: EXHIBIT_FILE,
      errors: [{ messageId: "deepImport" }],
      output: `import { a } from "../../core";`,
    },
    // …and web/ gains nothing from it: web/ into exhibits/ is still deep.
    {
      code: `import { a } from "../../exhibits/internal/x";`,
      filename: WEB_FILE,
      errors: [{ messageId: "deepImport" }],
      output: `import { a } from "../../exhibits";`,
    },
    // `export *` from the barrel re-exports a different set — no autofix.
    {
      code: `export * from "../../core/types";`,
      filename: WEB_FILE,
      errors: [{ messageId: "deepImport" }],
      output: null,
    },
  ],
});
