/**
 * Tests for the `no-adhoc-new-tab` lint rule: every read of `navIcons.newTab`
 * from the icons core is flagged; the other nav icons, and a `navIcons` that is
 * not the icons core's, are not.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-adhoc-new-tab";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const IMPORT = `import { navIcons } from "@plugins/ui/plugins/icons/core";`;
const adhoc = { messageId: "adhoc" } as const;

// `RuleTester.run` drives the harness itself, so it runs at module top level.
ruleTester.run(
  "no-adhoc-new-tab",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      {
        code: `${IMPORT}\nconst a = navIcons.newAppTab;\nconst b = navIcons.sidePane;`,
      },
      { code: `const navIcons = { newTab: 1 };\nconst a = navIcons.newTab;` },
      {
        code: `import { navIcons } from "somewhere-else";\nconst a = navIcons.newTab;`,
      },
    ],
    invalid: [
      { code: `${IMPORT}\nconst a = navIcons.newTab;`, errors: [adhoc] },
      { code: `${IMPORT}\nconst a = navIcons["newTab"];`, errors: [adhoc] },
      { code: `${IMPORT}\nconst { newTab } = navIcons;`, errors: [adhoc] },
      {
        code: `import { navIcons as n } from "@plugins/ui/plugins/icons/core";\nconst a = n.newTab;`,
        errors: [adhoc],
      },
    ],
  },
);
