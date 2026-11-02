import rule from "./reserved-nav-icon";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const IMPORT = `import { symbol, navIcons } from "@plugins/ui/plugins/icons/core";`;

ruleTester.run("reserved-nav-icon", rule, {
  valid: [
    {
      code: `${IMPORT}\nconst a = symbol("forum");\nconst b = navIcons.newTab;`,
    },
    // A `symbol` from elsewhere is not the icons one.
    { code: `import { symbol } from "./other";\nsymbol("open-in-new");` },
  ],
  invalid: [
    {
      code: `${IMPORT}\nconst a = symbol("open-in-new");`,
      errors: [{ messageId: "reserved" }],
    },
    {
      code: `${IMPORT}\nconst a = symbol("right-panel-open");`,
      errors: [{ messageId: "reserved" }],
    },
    {
      code: `${IMPORT}\nconst a = symbol("open-in-full");`,
      errors: [{ messageId: "reserved" }],
    },
  ],
});
